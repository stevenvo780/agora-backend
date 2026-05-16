/**
 * Núcleo del razonamiento Belnap-aware.
 *
 * Estrategia de evaluación:
 *   1. Chequeo clásico primero. Si la fórmula es una tautología clásica → T;
 *      si es una contradicción clásica → F (salvo que el perfil sea Belnap,
 *      donde P∧¬P puede tomar el valor 'both').
 *   2. Para perfiles Belnap (paraconsistent.belnap): analizar la tabla de
 *      verdad cuadrivaluada producida por st-lang.
 *      Valores designados: {T, B}; no designados: {F, N}.
 *      - Si existe fila con B (both) en los resultados → 'both' (inconsistente)
 *      - Si todas las filas dan valor designado → 'T'
 *      - Si todas las filas dan valor no designado, sin B → 'F'
 *      - Si sólo aparece N sin B → 'neither'
 *   3. Para otros perfiles o cuando no hay tabla: 'T' si válido, 'F' si unsat,
 *      'neither' si contingente/desconocido.
 */
import { evaluate as evaluateST, listProfiles } from '@/lib/st-api';
import type { BelnapAnalysis, BelnapValue } from './types';

const BELNAP_PROFILE = 'paraconsistent.belnap';

/**
 * Verifica si el perfil dado corresponde al sistema de Belnap FOUR.
 * Cae a false cuando el perfil no existe en st-lang.
 */
function isBelnapProfile(profile: string): boolean {
  const known = new Set(listProfiles().map(String));
  return profile === BELNAP_PROFILE && known.has(BELNAP_PROFILE);
}

/**
 * Ejecuta el programa ST bajo el perfil dado y devuelve datos de evaluación.
 *
 * Para perfiles Belnap, el motor de st-lang devuelve 'invalid' incluso para
 * tautologías clásicas (ya que Belnap no tiene tautologías absolutas). Por
 * eso siempre corremos también un chequeo clásico separado que determina si
 * la fórmula es tautología clásica (valor 'T') o contradicción clásica
 * (valor 'F'). La tabla cuadrivaluada del perfil Belnap se usa para el
 * diagnóstico de 'both'/'neither'.
 */
function runCheck(profile: string, formula: string): {
  isClassicallyValid: boolean;
  isClassicallySat: boolean;
  belnapRows: Array<{ result: string }>;
} {
  // Chequeo clásico independiente del perfil activo, para detectar tautologías
  // y contradicciones clásicas que son el punto de partida del mapa Belnap.
  const classicalProgram = [
    'logic classical.propositional',
    `check valid (${formula})`,
    `check satisfiable (${formula})`
  ].join('\n');
  const classicalR = evaluateST(classicalProgram);
  const classicalValid = classicalR.results[0];
  const classicalSat = classicalR.results[1];

  const isClassicallyValid =
    classicalValid?.status === 'valid' || classicalValid?.status === 'provable';

  const isClassicallySat =
    classicalSat?.status === 'satisfiable' ||
    classicalSat?.status === 'valid' ||
    classicalSat?.status === 'provable';

  // Cuando el perfil es Belnap, evaluamos también bajo ese perfil para obtener
  // la tabla cuadrivaluada (filas T/F/B/N) que distingue 'both' de 'neither'.
  let belnapRows: Array<{ result: string }> = [];
  if (isBelnapProfile(profile)) {
    const belnapProgram = [
      `logic ${profile}`,
      `check valid (${formula})`
    ].join('\n');
    const belnapR = evaluateST(belnapProgram);
    const belnapResult = belnapR.results[0];
    const rawRows: unknown = belnapResult?.truthTable?.rows;
    belnapRows = Array.isArray(rawRows)
      ? rawRows.filter(
          (row): row is { result: string } =>
            row !== null &&
            typeof row === 'object' &&
            'result' in row &&
            typeof (row as Record<string, unknown>).result === 'string'
        )
      : [];
  }

  return { isClassicallyValid, isClassicallySat, belnapRows };
}

/**
 * Determina el BelnapValue de una fórmula dado el perfil y los datos de
 * evaluación ya calculados.
 *
 * En perfiles Belnap la tabla de verdad cuadrivaluada tiene filas con
 * resultados 'T', 'F', 'B' (both) o 'N' (neither). La presencia de
 * filas 'B' señala sobre-determinación; la de filas 'N', sub-determinación.
 */
function deriveBelnapValue(
  profile: string,
  isClassicallyValid: boolean,
  isClassicallySat: boolean,
  belnapRows: Array<{ result: string }>
): BelnapValue {
  // Tautología clásica → T en cualquier perfil.
  if (isClassicallyValid) return 'T';

  if (isBelnapProfile(profile) && belnapRows.length > 0) {
    const hasBothRow = belnapRows.some((row) => row.result === 'B');
    const hasNeitherRow = belnapRows.some((row) => row.result === 'N');
    const allDesignated = belnapRows.every(
      (row) => row.result === 'T' || row.result === 'B'
    );
    const allNonDesignated = belnapRows.every(
      (row) => row.result === 'F' || row.result === 'N'
    );

    if (allDesignated) return 'T';
    if (hasBothRow) return 'both';
    if (allNonDesignated && hasNeitherRow && !hasBothRow) return 'neither';
    if (allNonDesignated) return 'F';

    // Mixto sin fila B → ni tautología ni contradicción ni sub-det: 'neither'
    return 'neither';
  }

  // Perfil no-Belnap o sin tabla: inferir desde sat/valid clásico.
  if (!isClassicallySat) return 'F';

  // Contingente (satisfacible pero no válido) → 'neither' (info insuficiente)
  return 'neither';
}

const RECOMMENDATIONS: Record<BelnapValue, string> = {
  T: 'La fórmula es verdadera bajo este perfil. Usar como axioma o premisa firme.',
  F: 'La fórmula es falsa. Añadir su negación al conjunto de premisas.',
  both:
    'La base de conocimiento contiene información contradictoria sobre esta fórmula. ' +
    'Investigar la contradicción y restringir las hipótesis.',
  neither:
    'No hay información suficiente para determinar el valor de la fórmula. ' +
    'Añadir información adicional o considerar otra perspectiva.'
};

const CONSISTENCY_MAP: Record<BelnapValue, BelnapAnalysis['consistency']> = {
  T: 'consistent',
  F: 'consistent',
  both: 'inconsistent',
  neither: 'incomplete'
};

const TACTICS: Record<BelnapValue, string[]> = {
  T: [
    'Incorporar la fórmula como premisa validada.',
    'Usarla como base para derivar consecuencias.',
    'Documentar el axioma en el registro de conocimiento.'
  ],
  F: [
    'Añadir ¬fórmula al conjunto de premisas.',
    'Revisar si alguna hipótesis que la implicaba puede descartarse.',
    'Registrar la refutación como restricción del dominio.'
  ],
  both: [
    'Localizar las fuentes de la contradicción en la base de conocimiento.',
    'Aplicar revisión de creencias (AGM): contracción o revisión.',
    'Dividir el contexto en sub-teorías consistentes.',
    'Considerar una hipótesis de restricción que resuelva la ambigüedad.',
    'Escalar al usuario si la contradicción no se puede resolver automáticamente.'
  ],
  neither: [
    'Solicitar información adicional al usuario o a fuentes externas.',
    'Explorar fórmulas relacionadas para acotar el espacio de verdad.',
    'Proponer hipótesis alternativas y evaluar su consistencia.',
    'Considerar un cierre bajo suposición de mundo cerrado (CWA) si aplica.'
  ]
};

/**
 * Analiza una fórmula lógica bajo el perfil dado y devuelve un
 * BelnapAnalysis con el valor cuadrivaluado, la recomendación y tácticas
 * para el agente IA.
 *
 * @param formula - Fórmula en notación ST (p. ej. 'P -> Q', 'P & ~P').
 * @param profile - Perfil lógico de st-lang (p. ej. 'paraconsistent.belnap').
 *                  Si no es Belnap, los valores se mapean desde clásico.
 */
export async function analyzeBelnap(
  formula: string,
  profile: string
): Promise<BelnapAnalysis> {
  const { isClassicallyValid, isClassicallySat, belnapRows } = runCheck(
    profile,
    formula
  );

  const value = deriveBelnapValue(
    profile,
    isClassicallyValid,
    isClassicallySat,
    belnapRows
  );

  return {
    value,
    recommendation: RECOMMENDATIONS[value],
    consistency: CONSISTENCY_MAP[value],
    suggestedTactics: TACTICS[value]
  };
}
