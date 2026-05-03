import type { Diagnostic, STEvalResult } from '@/lib/st-api';

const diagnosticKey = (diagnostic: Diagnostic) => JSON.stringify([
  diagnostic.severity,
  diagnostic.message,
  diagnostic.file ?? null,
  diagnostic.line ?? null,
  diagnostic.column ?? null,
  diagnostic.code ?? null
]);

export const collectSTDiagnostics = (result: STEvalResult): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [...(result.diagnostics ?? [])];

  for (const commandResult of result.results ?? []) {
    if (Array.isArray(commandResult.diagnostics) && commandResult.diagnostics.length > 0) {
      diagnostics.push(...commandResult.diagnostics);
      continue;
    }

    if (commandResult.status === 'error') {
      diagnostics.push({
        severity: 'error',
        message: typeof commandResult.output === 'string' && commandResult.output.trim()
          ? commandResult.output.trim()
          : 'El comando ST devolvió error.'
      });
    }
  }

  const deduped = new Map<string, Diagnostic>();
  diagnostics.forEach((diagnostic) => {
    deduped.set(diagnosticKey(diagnostic), diagnostic);
  });
  return Array.from(deduped.values());
};

export const hasSTExecutionErrors = (result: STEvalResult) => (
  result.results?.some((commandResult) => commandResult.status === 'error')
  || collectSTDiagnostics(result).some((diagnostic) => diagnostic.severity === 'error')
);
