/**
 * Tipos públicos del feedback-loop LLM ↔ ST.
 *
 * El loop persigue una derivación lógica: el LLM propone una derivación o
 * fórmula objetivo, ST la valida, y si falla devolvemos un contramodelo
 * estructurado al LLM para que corrija. Se itera hasta `maxIterations`
 * (default 3) o hasta que ST acepte la derivación.
 */

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type LLMCaller = (prompt: string, history: Message[]) => Promise<string>;

export interface FeedbackLoopOptions {
  /** Máximo de iteraciones del bucle. Default 3. */
  maxIterations?: number;
  /** Perfil ST. Default 'classical.propositional'. */
  profile?: string;
  /** Función que invoca al LLM. Recibe el prompt actual y el historial. */
  llmCaller: LLMCaller;
  /** Instrucciones de sistema adicionales prepuestas al historial. */
  systemPrompt?: string;
}

export interface STValidationErrorEntry {
  message: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
  line?: number;
  column?: number;
  code?: string;
}

export interface STValidationOutcome {
  valid: boolean;
  errors?: STValidationErrorEntry[];
  countermodel?: Record<string, boolean | 'T' | 'F' | 'both' | 'neither'>;
}

export interface FeedbackLoopIteration {
  iter: number;
  llmResponse: string;
  stValidation: STValidationOutcome;
}

export interface FeedbackLoopResult {
  success: boolean;
  iterations: number;
  finalDerivation?: string;
  finalProof?: {
    steps: Array<{
      stepNumber: number;
      formula: string;
      justification: string;
      premises: number[];
    }>;
  };
  history: FeedbackLoopIteration[];
  profile: string;
  premises: string[];
  goal: string;
}
