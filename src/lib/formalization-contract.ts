import type { Diagnostic as STDiagnostic } from '@stevenvo780/st-lang/api';

export const FORMALIZATION_CONTRACT_VERSION = '2026-04-11.v1';

export type FormalizationEngine = 'nlp' | 'llm';

export interface FormalizationTrace {
  inferredByRules: boolean;
  inferredByLLM: boolean;
  userEdited: boolean;
}

export interface FormalizationResultPayload {
  contractVersion: string;
  ok: boolean;
  stCode: string;
  ast: unknown | null;
  linterDiagnostics: unknown[];
  diagnostics: STDiagnostic[];
  atomCount: number;
  formulaCount: number;
  claimCount: number;
  confidence: number;
  engine: FormalizationEngine;
  patterns: string[];
  trace: FormalizationTrace;
  error?: string;
}

export const emptyFormalizationResultPayload = (
  engine: FormalizationEngine,
  error?: string
): FormalizationResultPayload => ({
  contractVersion: FORMALIZATION_CONTRACT_VERSION,
  ok: false,
  stCode: '',
  ast: null,
  linterDiagnostics: [],
  diagnostics: [],
  atomCount: 0,
  formulaCount: 0,
  claimCount: 0,
  confidence: 0,
  engine,
  patterns: [],
  trace: {
    inferredByRules: engine === 'nlp',
    inferredByLLM: engine === 'llm',
    userEdited: false
  },
  ...(error ? { error } : {})
});

export const clampConfidence = (value: number) => Math.max(0, Math.min(1, value));
