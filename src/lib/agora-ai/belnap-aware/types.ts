/**
 * Tipos públicos del módulo belnap-aware.
 *
 * BelnapValue refleja los cuatro valores de la lógica de Belnap (FOUR):
 *   T       — verdadero (designado, clásico)
 *   F       — falso (no designado, clásico)
 *   both    — sobre-determinado: la base de conocimiento afirma y niega P
 *   neither — sub-determinado: no hay información suficiente sobre P
 */
export type BelnapValue = 'T' | 'F' | 'both' | 'neither';

export interface BelnapAnalysis {
  value: BelnapValue;
  /** Qué hacer el agente ante este resultado. */
  recommendation: string;
  consistency: 'consistent' | 'inconsistent' | 'incomplete' | 'undetermined';
  /** Próximas acciones concretas que el agente debe considerar. */
  suggestedTactics: string[];
}

export interface BelnapStrategy {
  primaryGoal: string;
  subgoals: string[];
}
