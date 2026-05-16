/**
 * st_countermodel — si la fórmula NO es válida en el perfil, devuelve un
 * contramodelo concreto. Si es válida, retorna `{ valid: true }` sin
 * assignments.
 */
import type { AgentToolCall, AgentExecutionContext, AgentToolExecutionResult } from '@/lib/agora-ai/types';
import { ok } from '../shared';
import {
  diagnosticsToErrors,
  normalizeValuation,
  readRequiredString,
  resolveProfile,
  runST,
  type STAssignmentMap
} from './shared';

export async function stCountermodel(call: AgentToolCall, _ctx: AgentExecutionContext): Promise<AgentToolExecutionResult> {
  const formula = readRequiredString(call.args, 'formula');
  const profile = resolveProfile(call.args.profile);

  // Paso 1: check valid — si ya es válida no hay contramodelo posible.
  const checkProgram = `check valid (${formula})`;
  const checkRun = runST(profile, checkProgram);
  const checkLast = checkRun.results[0];
  const isValid = checkLast?.status === 'valid' || checkLast?.status === 'provable';

  if (isValid) {
    return ok(call, `Fórmula válida bajo ${profile}: no existe contramodelo.`, {
      valid: true,
      profile,
      formula,
      errors: diagnosticsToErrors(checkRun.diagnostics)
    });
  }

  // Paso 2: pedir un contramodelo explícito a st-lang.
  const cmProgram = `countermodel (${formula})`;
  const cmRun = runST(profile, cmProgram);
  const cmResult = cmRun.results[0];
  const assignments: STAssignmentMap = normalizeValuation(cmResult?.model?.valuation);
  const errors = diagnosticsToErrors([...checkRun.diagnostics, ...cmRun.diagnostics]);

  if (Object.keys(assignments).length === 0) {
    return ok(call, `Fórmula no válida bajo ${profile}, pero st-lang no devolvió un contramodelo explícito.`, {
      valid: false,
      profile,
      formula,
      assignments: {},
      errors
    });
  }

  const assignmentSummary = Object.entries(assignments)
    .map(([atom, value]) => `${atom}=${String(value)}`)
    .join(', ');

  return ok(call, `Contramodelo bajo ${profile}: ${assignmentSummary}`, {
    valid: false,
    profile,
    formula,
    assignments,
    errors
  });
}
