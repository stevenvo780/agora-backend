/**
 * Bucle iterativo LLM ↔ ST.
 *
 * Flujo de cada iteración:
 *   1. Llamar al LLM (initial prompt en iter 1; retry prompt con
 *      contramodelo del fallo previo en iter ≥ 2).
 *   2. Extraer la fórmula candidata de la respuesta.
 *   3. Validar con `stDerive` (premisas → candidata).
 *   4. Si valid=true → success. Si no, recuperar contramodelo y re-prompt.
 *
 * Las tools `st_derive` y `st_countermodel` (γ1) se invocan directamente
 * por función — no via `executeAgentTool` — porque el feedback-loop es
 * una librería pura sin AgentExecutionContext (no toca Firestore, audit
 * log ni access policy). El contrato de input/output es idéntico.
 */
import type { AgentExecutionContext, AgentToolCall } from '@/lib/agora-ai/types';
import { stDerive } from '@/lib/agora-ai/toolExecutors/st-typed/derive';
import { stCountermodel } from '@/lib/agora-ai/toolExecutors/st-typed/countermodel';
import { stCheck } from '@/lib/agora-ai/toolExecutors/st-typed/check';
import { extractCandidate } from './extract';
import { buildInitialPrompt, buildRetryPrompt } from './prompt';
import type {
  FeedbackLoopIteration,
  FeedbackLoopOptions,
  FeedbackLoopResult,
  Message,
  STValidationErrorEntry,
  STValidationOutcome
} from './types';

const DEFAULT_MAX_ITERATIONS = 3;
const DEFAULT_PROFILE = 'classical.propositional';

interface DerivePayload {
  valid: boolean;
  steps: Array<{
    stepNumber: number;
    formula: string;
    justification: string;
    premises: number[];
  }>;
  countermodel?: Record<string, boolean | 'T' | 'F' | 'both' | 'neither'>;
  errors?: STValidationErrorEntry[];
}

interface CountermodelPayload {
  valid: boolean;
  assignments?: Record<string, boolean | 'T' | 'F' | 'both' | 'neither'>;
  errors?: STValidationErrorEntry[];
}

interface CheckPayload {
  valid: boolean;
  errors?: STValidationErrorEntry[];
  result?: string;
}

const STUB_CTX: AgentExecutionContext = {
  workspaceId: '__feedback-loop__',
  uid: '__feedback-loop__'
};

const stubCall = (name: string, args: Record<string, unknown>): AgentToolCall => ({
  id: `${name}-feedback`,
  name,
  args
});

export async function feedbackDerive(
  premises: string[],
  goal: string,
  opts: FeedbackLoopOptions
): Promise<FeedbackLoopResult> {
  if (typeof opts?.llmCaller !== 'function') {
    throw new Error('llmCaller es requerido (function).');
  }
  const maxIterations = Math.max(1, Math.min(10, opts.maxIterations ?? DEFAULT_MAX_ITERATIONS));
  const profile = typeof opts.profile === 'string' && opts.profile.length > 0
    ? opts.profile
    : DEFAULT_PROFILE;

  const safePremises = sanitizeStringList(premises);
  const safeGoal = String(goal ?? '').trim();
  if (!safeGoal) {
    throw new Error('goal es requerido (string no vacío).');
  }

  const history: FeedbackLoopIteration[] = [];
  const chatHistory: Message[] = opts.systemPrompt
    ? [{ role: 'system', content: opts.systemPrompt }]
    : [];

  let lastValidation: STValidationOutcome | null = null;
  let lastResponse = '';
  let finalDerivation: string | undefined;
  let finalSteps: DerivePayload['steps'] | undefined;

  for (let iter = 1; iter <= maxIterations; iter++) {
    const prompt = iter === 1
      ? buildInitialPrompt({ premises: safePremises, goal: safeGoal, profile })
      : buildRetryPrompt({
          previousResponse: lastResponse,
          validation: lastValidation ?? { valid: false },
          goal: safeGoal,
          iteration: iter,
          maxIterations
        });

    const llmResponse = await opts.llmCaller(prompt, [...chatHistory]);
    lastResponse = llmResponse;
    chatHistory.push({ role: 'user', content: prompt });
    chatHistory.push({ role: 'assistant', content: llmResponse });

    const candidate = extractCandidate(llmResponse);
    if (!candidate) {
      const validation: STValidationOutcome = {
        valid: false,
        errors: [{
          severity: 'error',
          message: 'No se pudo extraer una fórmula candidata de la respuesta del LLM.'
        }]
      };
      lastValidation = validation;
      history.push({ iter, llmResponse, stValidation: validation });
      continue;
    }

    const validation = await validateDerivation({
      premises: safePremises,
      candidate: candidate.formula,
      goal: safeGoal,
      profile
    });
    lastValidation = validation.outcome;
    history.push({ iter, llmResponse, stValidation: validation.outcome });

    if (validation.outcome.valid) {
      finalDerivation = candidate.formula;
      finalSteps = validation.steps;
      return {
        success: true,
        iterations: iter,
        finalDerivation,
        ...(finalSteps ? { finalProof: { steps: finalSteps } } : {}),
        history,
        profile,
        premises: safePremises,
        goal: safeGoal
      };
    }
  }

  return {
    success: false,
    iterations: history.length,
    history,
    profile,
    premises: safePremises,
    goal: safeGoal
  };
}

async function validateDerivation(params: {
  premises: string[];
  candidate: string;
  goal: string;
  profile: string;
}): Promise<{ outcome: STValidationOutcome; steps?: DerivePayload['steps'] }> {
  const { premises, candidate, goal, profile } = params;

  // Sin premisas: st-lang no acepta `derive (f) from {}`. Usamos `check valid`
  // que es el chequeo natural de tautología y devuelve el mismo veredicto.
  if (premises.length === 0) {
    const checkResult = await stCheck(
      stubCall('st_check', { formula: candidate, profile }),
      STUB_CTX
    );
    const checkPayload = (checkResult.data ?? {}) as unknown as CheckPayload;
    const checkErrors = Array.isArray(checkPayload.errors) ? checkPayload.errors : [];

    if (checkPayload.valid && normalize(candidate) === normalize(goal)) {
      return { outcome: { valid: true, errors: checkErrors }, steps: [] };
    }
    return {
      outcome: {
        valid: false,
        errors: checkErrors,
        ...(await fetchCountermodel(goal, profile))
      }
    };
  }

  // El LLM debe demostrar el goal; toleramos que devuelva el goal literal
  // o una fórmula equivalente. Validamos la fórmula que envió.
  const deriveResult = await stDerive(
    stubCall('st_derive', { premises, goal: candidate, profile }),
    STUB_CTX
  );

  const payload = (deriveResult.data ?? {}) as unknown as DerivePayload;
  const errors = Array.isArray(payload.errors) ? payload.errors : [];

  // Caso A: la candidata coincide con el goal y es derivable → éxito directo.
  if (payload.valid && normalize(candidate) === normalize(goal)) {
    return {
      outcome: { valid: true, errors },
      steps: payload.steps
    };
  }

  // Caso B: la candidata es derivable pero no es el goal — re-validar el goal
  // tomando la candidata como premisa adicional. Si así se derive, también
  // contamos como éxito (el LLM hizo el paso intermedio bien).
  if (payload.valid) {
    const goalCheck = await stDerive(
      stubCall('st_derive', {
        premises: [...premises, candidate],
        goal,
        profile
      }),
      STUB_CTX
    );
    const goalPayload = (goalCheck.data ?? {}) as unknown as DerivePayload;
    if (goalPayload.valid) {
      return {
        outcome: { valid: true, errors: goalPayload.errors ?? [] },
        steps: goalPayload.steps
      };
    }
    // Candidata válida pero no implica el goal: tratamos como fallo.
    return {
      outcome: {
        valid: false,
        errors: [
          ...errors,
          {
            severity: 'error',
            message: `La fórmula "${candidate}" es derivable, pero no implica el goal "${goal}".`
          }
        ],
        ...(await fetchCountermodel(goal, profile))
      }
    };
  }

  // Caso C: la candidata no es derivable — pedimos contramodelo del goal
  // para guiar al LLM.
  const counter = await fetchCountermodel(goal, profile);
  return {
    outcome: {
      valid: false,
      errors,
      ...counter
    }
  };
}

async function fetchCountermodel(formula: string, profile: string): Promise<{
  countermodel?: Record<string, boolean | 'T' | 'F' | 'both' | 'neither'>;
}> {
  try {
    const r = await stCountermodel(
      stubCall('st_countermodel', { formula, profile }),
      STUB_CTX
    );
    const data = (r.data ?? {}) as unknown as CountermodelPayload;
    if (!data.valid && data.assignments && Object.keys(data.assignments).length > 0) {
      return { countermodel: data.assignments };
    }
  } catch {
    // st_countermodel puede fallar para perfiles que no lo soportan; en ese
    // caso seguimos sin contramodelo y dejamos que el LLM trabaje con los
    // errors estructurados.
  }
  return {};
}

function sanitizeStringList(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function normalize(s: string): string {
  return s
    .replace(/\s+/g, '')
    .replace(/[()]/g, '')
    .toLowerCase();
}
