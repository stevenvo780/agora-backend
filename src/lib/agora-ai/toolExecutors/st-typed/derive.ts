/**
 * st_derive — intenta derivar `goal` desde `premises` bajo un perfil lógico.
 *
 * Modelo: cada premisa se registra como `axiom p_i : <expr>` y se invoca
 * `derive goal from {p_0, p_1, ...}`. Si la derivación es exitosa, devuelve
 * los pasos de la prueba serializados. Si falla, intenta obtener un
 * contramodelo via `countermodel <goal>` para que el modelo entienda por qué.
 */
import type { AgentToolCall, AgentExecutionContext, AgentToolExecutionResult } from '@/lib/agora-ai/types';
import type { Proof } from '@stevenvo780/st-lang/api';

type ProofStep = Proof['steps'][number];
import { ok } from '../shared';
import {
  diagnosticsToErrors,
  normalizeValuation,
  readRequiredString,
  readStringArray,
  resolveProfile,
  runST,
  type STAssignmentMap,
  type STDeriveStepDTO
} from './shared';

const stripParens = (s: string): string => {
  const t = s.trim();
  return t.startsWith('(') && t.endsWith(')') ? t.slice(1, -1) : t;
};

const formatStep = (step: ProofStep): STDeriveStepDTO => ({
  stepNumber: step.stepNumber,
  formula: stripParens(formulaToText(step.formula)),
  justification: step.justification,
  premises: Array.isArray(step.premises) ? [...step.premises] : [],
  ...(step.source ? { source: step.source } : {})
});

/**
 * Convierte una Formula AST de st-lang a texto legible. Las fórmulas en los
 * proofs traen `source.fragment` ocasionalmente; si no, reconstruimos algo
 * razonable a partir del kind. Fallback: JSON.stringify resumido.
 */
function formulaToText(formula: unknown): string {
  if (!formula || typeof formula !== 'object') return String(formula ?? '');
  const f = formula as { kind?: string; name?: string; args?: unknown[]; value?: number };
  switch (f.kind) {
    case 'atom':
    case 'predicate':
      return f.name || '?';
    case 'true':
      return '⊤';
    case 'false':
      return '⊥';
    case 'not':
      return `¬${formulaToText(f.args?.[0])}`;
    case 'and':
      return `(${(f.args || []).map(formulaToText).join(' ∧ ')})`;
    case 'or':
      return `(${(f.args || []).map(formulaToText).join(' ∨ ')})`;
    case 'implies':
      return `(${formulaToText(f.args?.[0])} → ${formulaToText(f.args?.[1])})`;
    case 'biconditional':
      return `(${formulaToText(f.args?.[0])} ↔ ${formulaToText(f.args?.[1])})`;
    case 'number':
      return String(f.value ?? 0);
    default:
      return f.name || f.kind || '?';
  }
}

export async function stDerive(call: AgentToolCall, _ctx: AgentExecutionContext): Promise<AgentToolExecutionResult> {
  const premises = readStringArray(call.args, 'premises', true);
  const goal = readRequiredString(call.args, 'goal');
  const profile = resolveProfile(call.args.profile);

  const axiomLines = premises.map((p, idx) => `axiom p${idx} : (${p})`);
  const axiomNames = premises.map((_, idx) => `p${idx}`);
  const deriveLine = axiomNames.length === 0
    ? `derive (${goal})`
    : `derive (${goal}) from {${axiomNames.join(', ')}}`;

  const program = [...axiomLines, deriveLine].join('\n');
  const r = runST(profile, program);

  const errors = diagnosticsToErrors(r.diagnostics);
  const last = r.results[r.results.length - 1];
  const valid = last?.status === 'provable' || last?.status === 'valid';

  const steps: STDeriveStepDTO[] = (last?.proof?.steps ?? []).map(formatStep);

  let countermodel: STAssignmentMap | undefined;
  if (!valid) {
    // Intentamos buscar un contramodelo del goal para diagnosticar.
    const cmProgram = `countermodel (${goal})`;
    const cm = runST(profile, cmProgram);
    const cmRes = cm.results[0];
    if (cmRes?.model?.valuation) {
      countermodel = normalizeValuation(cmRes.model.valuation);
    }
  }

  const summary = valid
    ? `Goal "${goal}" derivable desde ${premises.length} premisa(s) bajo ${profile}.`
    : `No se pudo derivar "${goal}" bajo ${profile} (status=${last?.status ?? 'unknown'}).`;

  return ok(call, summary, {
    valid,
    steps,
    profile,
    premises,
    goal,
    errors,
    ...(countermodel ? { countermodel } : {})
  });
}
