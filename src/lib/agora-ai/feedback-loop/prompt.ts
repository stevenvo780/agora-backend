/**
 * Construye los prompts que se envían al LLM en cada iteración del bucle.
 *
 * - `buildInitialPrompt` arma el primer prompt con premisas + goal.
 * - `buildRetryPrompt` arma el re-prompt cuando ST rechazó la derivación
 *   anterior; incluye el contramodelo y los errores estructurados para
 *   que el LLM pueda corregir.
 */
import type { STValidationOutcome } from './types';

const FORMAT_GUIDE = [
  'Formato esperado de respuesta:',
  '  • Razonamiento breve (1-3 líneas).',
  '  • En la última línea: la fórmula objetivo derivada en notación ST',
  '    (P, Q, ¬, ∧, ∨, →, ↔ — también se acepta ~, &, |, ->).',
  '  • Opcionalmente, envolvé la conclusión en un bloque ```st ... ```.'
].join('\n');

export function buildInitialPrompt(params: {
  premises: string[];
  goal: string;
  profile: string;
}): string {
  const { premises, goal, profile } = params;
  const premisesBlock = premises.length === 0
    ? '(sin premisas — el goal debe ser una tautología)'
    : premises.map((p, idx) => `  ${idx + 1}. ${p}`).join('\n');

  return [
    `Sos un asistente de lógica formal. Perfil: ${profile}.`,
    '',
    'Premisas:',
    premisesBlock,
    '',
    `Goal a derivar: ${goal}`,
    '',
    FORMAT_GUIDE
  ].join('\n');
}

export function buildRetryPrompt(params: {
  previousResponse: string;
  validation: STValidationOutcome;
  goal: string;
  iteration: number;
  maxIterations: number;
}): string {
  const { previousResponse, validation, goal, iteration, maxIterations } = params;

  const errorLines = (validation.errors ?? [])
    .filter((e) => e.severity === 'error' || e.severity === 'warning')
    .slice(0, 5)
    .map((e) => `  • ${e.severity}: ${e.message}`);

  const counterLines = validation.countermodel
    ? Object.entries(validation.countermodel)
        .map(([atom, value]) => `  ${atom} = ${String(value)}`)
    : [];

  const sections: string[] = [
    `Tu derivación anterior NO es válida bajo ST (intento ${iteration}/${maxIterations}).`,
    '',
    'Tu respuesta anterior:',
    indent(previousResponse, '  > '),
    ''
  ];

  if (counterLines.length > 0) {
    sections.push(
      'Contramodelo concreto que falsifica el goal:',
      ...counterLines,
      ''
    );
  }

  if (errorLines.length > 0) {
    sections.push('Errores ST detectados:', ...errorLines, '');
  }

  sections.push(
    `Corregí la derivación para alcanzar el goal: ${goal}`,
    'Usá las premisas originales — no inventes premisas nuevas.',
    '',
    FORMAT_GUIDE
  );

  return sections.join('\n');
}

function indent(text: string, prefix: string): string {
  return text.split(/\r?\n/).map((line) => `${prefix}${line}`).join('\n');
}
