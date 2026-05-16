/**
 * st_check — verifica la validez de una fórmula bajo un perfil lógico.
 *
 * Estrategia: corre `check valid <formula>` y, en perfiles clásicos, también
 * `check satisfiable <formula>` para refinar el status (sat/unsat). La fórmula
 * se acepta tal cual el modelo la mande (notación ST u Unicode); st-lang la
 * normaliza internamente.
 */
import type { AgentToolCall, AgentExecutionContext, AgentToolExecutionResult } from '@/lib/agora-ai/types';
import { ok } from '../shared';
import {
  diagnosticsToErrors,
  mapLogicStatus,
  readRequiredString,
  resolveProfile,
  runST,
  type STCheckErrorEntry,
  type STCheckStatus
} from './shared';

export async function stCheck(call: AgentToolCall, _ctx: AgentExecutionContext): Promise<AgentToolExecutionResult> {
  const formula = readRequiredString(call.args, 'formula');
  const profile = resolveProfile(call.args.profile);

  const program = `check valid (${formula})\ncheck satisfiable (${formula})`;
  const r = runST(profile, program);

  const errors: STCheckErrorEntry[] = diagnosticsToErrors(r.diagnostics);

  let valid = false;
  let result: STCheckStatus = 'unknown';

  if (r.ok && r.results.length >= 1) {
    const validResult = r.results[0];
    const satResult = r.results[1];
    valid = validResult?.status === 'valid' || validResult?.status === 'provable';
    // Preferimos el status del check satisfiable para sat/unsat cuando aplica.
    result = mapLogicStatus(satResult?.status ?? validResult?.status);
    // Si valid pero el segundo paso da unknown, igual diremos sat (toda fórmula válida es sat).
    if (valid && result === 'unknown') result = 'sat';
  }

  const summary = valid
    ? `Fórmula válida bajo ${profile}.`
    : `Fórmula no válida bajo ${profile} (status=${result}).`;

  return ok(call, summary, {
    valid,
    errors,
    result,
    profile,
    formula
  });
}
