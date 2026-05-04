import { check as checkST, createInterpreter, evaluate as evaluateST, listProfiles } from '@/lib/st-api';
import { formalize as formalizeNLP, type LogicProfile } from '@stevenvo780/autologic';
import { collectSTDiagnostics, hasSTExecutionErrors } from '@/lib/st-execution';
import {
  type AgentToolCall, type AgentExecutionContext, type AgentToolExecutionResult,
  ok, getErrorMessage
} from './shared';

type ToolHandler = (call: AgentToolCall, ctx: AgentExecutionContext) => Promise<AgentToolExecutionResult>;

async function formalizeText(call: AgentToolCall, _ctx: AgentExecutionContext) {
  const text = String(call.args.text || '').trim();
  if (!text) throw new Error('text es requerido');

  const profileRaw = typeof call.args.profile === 'string' ? call.args.profile : 'classical.propositional';
  const language = call.args.language === 'en' ? 'en' : 'es';

  try {
    const r = formalizeNLP(text, {
      profile: profileRaw as LogicProfile,
      language: language as 'es' | 'en',
      atomStyle: 'keywords',
      includeComments: true
    });

    const confidence = r.ok ? 0.85 : 0.25;
    return ok(call, 'Texto formalizado correctamente.', {
      result: {
        stCode: r.stCode || '',
        confidence,
        diagnostics: r.diagnostics || [],
        patterns: r.analysis?.detectedPatterns || [],
        atomCount: r.atoms?.size || 0,
        formulaCount: r.formulas?.length || 0
      }
    });
  } catch (err) {
    throw new Error(`Error al formalizar: ${getErrorMessage(err)}`);
  }
}

// Compound tool: formalize natural text → run ST → return unified result
async function checkLogic(call: AgentToolCall, ctx: AgentExecutionContext) {
  const text = String(call.args.text || '').trim();
  if (!text) throw new Error('text es requerido');

  // Step 1: Formalize
  const formalizeResult = await formalizeText({
    ...call,
    id: `${call.id}-formalize`,
    name: 'formalize_text'
  }, ctx);

  const stCode = String((formalizeResult.data?.result as Record<string, unknown>)?.stCode || '').trim();
  const confidence = (formalizeResult.data?.result as Record<string, unknown>)?.confidence;
  const formalizeDiags = ((formalizeResult.data?.result as Record<string, unknown>)?.diagnostics || []) as unknown[];

  if (!stCode) {
    return ok(call, 'No se pudo formalizar el texto. El motor no produjo código ST.', {
      formalization: { ok: false, stCode: '', confidence: null, diagnostics: formalizeDiags },
      execution: null
    });
  }

  // Step 2: Execute the generated ST code
  let execution: Record<string, unknown>;
  try {
    const execResult = evaluateST(stCode);
    const executionOk = execResult.ok && !hasSTExecutionErrors(execResult);
    const executionDiagnostics = collectSTDiagnostics(execResult);
    const executionErrors = executionDiagnostics
      .filter((diagnostic) => diagnostic.severity === 'error')
      .map((diagnostic) => diagnostic.message)
      .filter((message) => message.trim().length > 0);
    execution = {
      ok: executionOk,
      stdout: execResult.stdout || '',
      stderr: executionOk ? (execResult.stderr || '') : executionErrors.join('\n') || execResult.stderr || '',
      diagnostics: executionDiagnostics
    };
  } catch (err) {
    execution = {
      ok: false,
      stdout: '',
      stderr: getErrorMessage(err),
      diagnostics: []
    };
  }

  const summary = [
    `**Texto original:** ${text}`,
    `**Código ST generado:**\n\`\`\`\n${stCode}\n\`\`\``,
    `**Confianza de formalización:** ${typeof confidence === 'number' ? `${(confidence * 100).toFixed(0)}%` : 'no reportada'}`,
    execution.ok
      ? `**Resultado:** ${String(execution.stdout || 'Ejecución exitosa sin salida.')}`
      : `**Error de ejecución:** ${String(execution.stderr || 'Error desconocido.')}`
  ].join('\n\n');

  return ok(call, summary, {
    formalization: { ok: true, stCode, confidence, diagnostics: formalizeDiags },
    execution
  });
}

async function listStProfilesTool(call: AgentToolCall) {
  const profiles = listProfiles();
  return ok(call, `Hay ${profiles.length} perfil(es) ST disponibles.`, { profiles });
}

async function validateStSyntax(call: AgentToolCall) {
  const program = String(call.args.program || call.args.code || '').trim();
  if (!program) throw new Error('program (o code) es requerido');
  const result = checkST(program);
  const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
  const errors = diagnostics.filter((item) => item.severity === 'error').length;
  return ok(call, errors ? `El programa ST tiene ${errors} error(es).` : 'El programa ST no tiene errores de sintaxis.', {
    diagnostics,
    errors,
    warnings: diagnostics.filter((item) => item.severity === 'warning').length
  });
}

async function runStProgram(call: AgentToolCall) {
  const program = String(call.args.program || call.args.code || '').trim();
  if (!program) throw new Error('program (o code) es requerido');
  const result = evaluateST(program);
  return ok(call, result.ok ? 'Programa ST ejecutado correctamente.' : 'La ejecución ST produjo errores.', {
    result: {
      ok: result.ok,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      diagnostics: Array.isArray(result.diagnostics) ? result.diagnostics : []
    }
  });
}

async function renderStGlossary(call: AgentToolCall) {
  const program = String(call.args.program || call.args.code || '').trim();
  if (!program) throw new Error('program (o code) es requerido');
  const format = call.args.format === 'markdown' ? 'markdown' : 'plain';
  const interpreter = createInterpreter();
  const bootstrap = interpreter.exec(program);
  if (!bootstrap.ok) {
    return ok(call, 'El programa base ST tiene errores y no se pudo renderizar el glosario.', {
      result: {
        ok: bootstrap.ok,
        stdout: bootstrap.stdout || '',
        stderr: bootstrap.stderr || '',
        diagnostics: Array.isArray(bootstrap.diagnostics) ? bootstrap.diagnostics : []
      }
    });
  }
  const glossaryCommand = format === 'markdown' ? 'render glossary as markdown' : 'glossary';
  const result = interpreter.exec(glossaryCommand);
  return ok(call, 'Glosario ST generado correctamente.', {
    result: {
      ok: result.ok,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      diagnostics: Array.isArray(result.diagnostics) ? result.diagnostics : []
    }
  });
}

async function explainFormalization(call: AgentToolCall, ctx: AgentExecutionContext) {
  const formalized = await formalizeText({
    ...call,
    id: `${call.id}-formalize`,
    name: 'formalize_text'
  }, ctx);
  const payload = formalized.data?.result as Record<string, unknown> | undefined;
  const stCode = String(payload?.stCode || '');
  const confidence = typeof payload?.confidence === 'number' ? payload.confidence : null;
  const profile = typeof call.args.profile === 'string' ? call.args.profile : 'classical.propositional';
  const explanation = [
    `Perfil lógico sugerido: ${profile}.`,
    'El texto se convirtió a ST para poder validarlo y reutilizarlo en el runtime.',
    stCode ? `Se obtuvo un bloque ST reutilizable de ${stCode.split(/\r?\n/).length} línea(s).` : 'No se obtuvo código ST.',
    confidence !== null ? `Confianza estimada: ${(confidence * 100).toFixed(0)}%.` : 'La confianza no fue reportada por el motor.',
    'Conviene revisar diagnósticos y, si hace falta, ejecutar el programa con run_st_program.'
  ].join(' ');
  return ok(call, 'Expliqué la formalización solicitada.', {
    explanation,
    result: payload || null
  });
}

export const ST_TOOL_HANDLERS: Record<string, ToolHandler> = {
  check_logic: checkLogic,
  formalize_text: formalizeText,
  list_st_profiles: listStProfilesTool,
  validate_st_syntax: validateStSyntax,
  run_st_program: runStProgram,
  render_st_glossary: renderStGlossary,
  explain_formalization: explainFormalization
};
