/**
 * Helpers tipados para las tools ST especializadas (st_check, st_derive,
 * st_countermodel, st_formalize). Mantienen una superficie estable
 * (input { formula, premises, goal, profile, ... }, output con `valid`,
 * `result`, `errors`, `steps`, `countermodel`, etc.) y aíslan el parseo
 * de argumentos del LLM en un solo lugar.
 *
 * Estas tools complementan a las heurísticas existentes (check_logic,
 * formalize_text, run_st_program) ofreciendo respuestas estructuradas
 * fáciles de consumir por el modelo sin tener que ejecutar `evaluate`
 * con un programa ST sintetizado.
 */
import { evaluate as evaluateST, listProfiles } from '@/lib/st-api';
import type { Diagnostic, RunResult, Valuation } from '@stevenvo780/st-lang/api';

export type ProfileName = string;

export type STCheckStatus = 'sat' | 'unsat' | 'unknown' | 'T' | 'F' | 'both' | 'neither';

export interface STCheckErrorEntry {
  message: string;
  line?: number;
  column?: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  code?: string;
}

export interface STDeriveStepDTO {
  stepNumber: number;
  formula: string;
  justification: string;
  premises: number[];
  source?: string;
}

export interface STAssignmentMap {
  [atom: string]: boolean | 'T' | 'F' | 'both' | 'neither';
}

const DEFAULT_PROFILE: ProfileName = 'classical.propositional';

/**
 * Resuelve el perfil ST a usar para la tool. Si el caller pasa uno válido lo
 * respeta; si no, cae a classical.propositional. La lista válida se calcula
 * en runtime (no es estática) porque st-lang puede registrar perfiles.
 */
export function resolveProfile(raw: unknown): ProfileName {
  if (typeof raw !== 'string' || raw.length === 0) return DEFAULT_PROFILE;
  const known = new Set(listProfiles().map(String));
  return known.has(raw) ? raw : DEFAULT_PROFILE;
}

/** Lee un string requerido del Record<string, unknown> del tool call. */
export function readRequiredString(args: Record<string, unknown>, key: string): string {
  const raw = args[key];
  if (typeof raw !== 'string') {
    throw new Error(`${key} es requerido (string).`);
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`${key} no puede estar vacío.`);
  }
  return trimmed;
}

/** Lee un array de strings requerido (acepta lista vacía si allowEmpty=true). */
export function readStringArray(
  args: Record<string, unknown>,
  key: string,
  allowEmpty: boolean
): string[] {
  const raw = args[key];
  if (!Array.isArray(raw)) {
    throw new Error(`${key} es requerido (array de strings).`);
  }
  const items = raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (!allowEmpty && items.length === 0) {
    throw new Error(`${key} no puede estar vacío.`);
  }
  return items;
}

/**
 * Convierte la lista de diagnósticos de st-lang al subset que devuelve la tool.
 * Solo se devuelven los relevantes (error/warning) para no inundar al modelo.
 */
export function diagnosticsToErrors(diags: Diagnostic[] | undefined): STCheckErrorEntry[] {
  if (!Array.isArray(diags)) return [];
  return diags
    .filter((d) => d.severity === 'error' || d.severity === 'warning')
    .map((d) => {
      const entry: STCheckErrorEntry = {
        message: d.message,
        severity: d.severity
      };
      if (typeof d.line === 'number') entry.line = d.line;
      if (typeof d.column === 'number') entry.column = d.column;
      if (typeof d.code === 'string') entry.code = d.code;
      return entry;
    });
}

/**
 * Maps un `RunResult.status` a la unión cerrada `STCheckStatus` que devuelve
 * `st_check`. Los perfiles Belnap/paraconsistent usan T/F/both/neither, los
 * clásicos sat/unsat. Si st-lang devuelve un status desconocido cae a 'unknown'.
 */
export function mapLogicStatus(status: string | undefined): STCheckStatus {
  switch (status) {
    case 'valid':
    case 'satisfiable':
    case 'provable':
      return 'sat';
    case 'invalid':
    case 'unsatisfiable':
    case 'refutable':
      return 'unsat';
    case 'T':
    case 'F':
    case 'both':
    case 'neither':
      return status;
    default:
      return 'unknown';
  }
}

/**
 * Algunos perfiles devuelven valuations no booleanas (Belnap: T/F/both/neither).
 * Esta función las normaliza al tipo cerrado de la tool.
 */
export function normalizeValuation(
  valuation: Valuation | Record<string, unknown> | undefined
): STAssignmentMap {
  if (!valuation || typeof valuation !== 'object') return {};
  const out: STAssignmentMap = {};
  for (const [atom, value] of Object.entries(valuation)) {
    if (typeof value === 'boolean') {
      out[atom] = value;
    } else if (value === 'T' || value === 'F' || value === 'both' || value === 'neither') {
      out[atom] = value;
    } else if (typeof value === 'string' && (value === 'true' || value === 'false')) {
      out[atom] = value === 'true';
    }
  }
  return out;
}

/**
 * Ejecuta un programa ST con un perfil concreto. El caller pasa los statements
 * lógicos (sin `logic <profile>`); este helper prepone la directiva.
 */
export function runST(profile: ProfileName, statements: string): {
  ok: boolean;
  stderr: string;
  diagnostics: Diagnostic[];
  results: RunResult[];
} {
  const source = `logic ${profile}\n${statements}`;
  const r = evaluateST(source);
  return {
    ok: r.ok,
    stderr: r.stderr,
    diagnostics: r.diagnostics,
    results: r.results
  };
}

export const DEFAULT_PROFILE_NAME = DEFAULT_PROFILE;
