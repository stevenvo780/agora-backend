import {
  type AgentToolCall, type AgentExecutionContext, type AgentToolExecutionResult,
  ok, clamp, adminDb, FieldValue
} from './shared';

type ToolHandler = (call: AgentToolCall, ctx: AgentExecutionContext) => Promise<AgentToolExecutionResult>;

const PLAN_STEP_STATES = ['pending', 'in_progress', 'completed', 'skipped', 'failed'] as const;
type PlanStepState = typeof PLAN_STEP_STATES[number];

interface PlanStep {
  index: number;
  description: string;
  status: PlanStepState;
  notes?: string;
  startedAt?: number;
  finishedAt?: number;
}

const turnPlans = new Map<string, PlanStep[]>();

const planKey = (ctx: AgentExecutionContext) => `${ctx.uid}:${ctx.workspaceId}`;

async function agentPlanSet(call: AgentToolCall, ctx: AgentExecutionContext) {
  const stepsRaw = Array.isArray(call.args.steps) ? call.args.steps : [];
  if (stepsRaw.length === 0) throw new Error('steps (array de strings) es requerido');
  if (stepsRaw.length > 30) throw new Error('Máximo 30 pasos por plan');
  const steps: PlanStep[] = stepsRaw.map((raw, index) => ({
    index,
    description: String(raw).slice(0, 280),
    status: 'pending'
  }));
  turnPlans.set(planKey(ctx), steps);
  return ok(call, `Plan creado con ${steps.length} paso(s).`, {
    plan: { steps },
    uiCommand: { type: 'agent-plan', action: 'set', steps }
  });
}

async function agentPlanUpdateStep(call: AgentToolCall, ctx: AgentExecutionContext) {
  const stepIndex = typeof call.args.stepIndex === 'number' ? call.args.stepIndex : -1;
  const status = String(call.args.status || '').trim() as PlanStepState;
  const notes = typeof call.args.notes === 'string' ? call.args.notes.slice(0, 500) : undefined;
  if (stepIndex < 0) throw new Error('stepIndex (≥0) es requerido');
  if (!PLAN_STEP_STATES.includes(status)) throw new Error(`status inválido (${PLAN_STEP_STATES.join('|')})`);
  const plan = turnPlans.get(planKey(ctx));
  if (!plan) throw new Error('No hay plan activo. Llama agent_plan_set primero.');
  const step = plan[stepIndex];
  if (!step) throw new Error(`stepIndex ${stepIndex} fuera de rango (max ${plan.length - 1})`);
  step.status = status;
  if (notes) step.notes = notes;
  if (status === 'in_progress' && !step.startedAt) step.startedAt = Date.now();
  if (['completed', 'skipped', 'failed'].includes(status)) step.finishedAt = Date.now();
  return ok(call, `Paso ${stepIndex} marcado ${status}.`, {
    step,
    plan: { steps: plan },
    uiCommand: { type: 'agent-plan', action: 'update', stepIndex, status, notes: notes ?? null }
  });
}

async function agentPlanGet(call: AgentToolCall, ctx: AgentExecutionContext) {
  const plan = turnPlans.get(planKey(ctx));
  if (!plan) return ok(call, 'No hay plan activo.', { plan: null });
  return ok(call, `Plan: ${plan.filter(s => s.status === 'completed').length}/${plan.length} completados.`, { plan: { steps: plan } });
}

async function agentPlanClear(call: AgentToolCall, ctx: AgentExecutionContext) {
  turnPlans.delete(planKey(ctx));
  return ok(call, 'Plan descartado.', { uiCommand: { type: 'agent-plan', action: 'clear' } });
}

const memoryDocRef = (uid: string, workspaceId: string, scope: 'user' | 'workspace') => {
  if (scope === 'user') return adminDb.collection('users').doc(uid).collection('agentMemory').doc('user');
  return adminDb.collection('users').doc(uid).collection('agentMemory').doc(`workspace:${workspaceId}`);
};

async function agentRemember(call: AgentToolCall, ctx: AgentExecutionContext) {
  const key = String(call.args.key || '').trim();
  const value = call.args.value;
  const scope = call.args.scope === 'user' ? 'user' : 'workspace';
  if (!key || key.length > 80) throw new Error('key (1..80 chars) es requerida');
  if (typeof value === 'undefined') throw new Error('value es requerido');
  const ref = memoryDocRef(ctx.uid, ctx.workspaceId, scope as 'user' | 'workspace');
  await ref.set({
    [`memories.${key}`]: {
      value,
      savedAt: FieldValue.serverTimestamp(),
      lastAccessedAt: FieldValue.serverTimestamp()
    }
  }, { merge: true });
  return ok(call, `Memoria "${key}" guardada en scope ${scope}.`, { key, scope }, [
    { action: 'agent_forget', args: { key, scope } }
  ]);
}

async function agentRecallMemory(call: AgentToolCall, ctx: AgentExecutionContext) {
  const key = typeof call.args.key === 'string' ? call.args.key.trim() : '';
  const scope = call.args.scope === 'user' ? 'user' : 'workspace';
  const ref = memoryDocRef(ctx.uid, ctx.workspaceId, scope as 'user' | 'workspace');
  const snap = await ref.get();
  const data = snap.data() as { memories?: Record<string, { value: unknown; savedAt?: unknown }> } | undefined;
  const memories = data?.memories || {};
  if (key) {
    const memory = memories[key];
    if (!memory) return ok(call, `No hay memoria "${key}" en scope ${scope}.`, { found: false });
    return ok(call, `Memoria "${key}" recuperada.`, { found: true, key, value: memory.value, scope });
  }
  const entries = Object.entries(memories).map(([k, v]) => ({ key: k, value: v.value }));
  return ok(call, `${entries.length} memoria(s) en scope ${scope}.`, { memories: entries, scope });
}

async function agentListMemories(call: AgentToolCall, ctx: AgentExecutionContext) {
  const [userSnap, workspaceSnap] = await Promise.all([
    memoryDocRef(ctx.uid, ctx.workspaceId, 'user').get(),
    memoryDocRef(ctx.uid, ctx.workspaceId, 'workspace').get()
  ]);
  const userMems = (userSnap.data() as { memories?: Record<string, unknown> } | undefined)?.memories || {};
  const wsMems = (workspaceSnap.data() as { memories?: Record<string, unknown> } | undefined)?.memories || {};
  return ok(call, `Memorias: ${Object.keys(userMems).length} user-scope, ${Object.keys(wsMems).length} workspace-scope.`, {
    userMemories: Object.keys(userMems),
    workspaceMemories: Object.keys(wsMems)
  });
}

async function agentForget(call: AgentToolCall, ctx: AgentExecutionContext) {
  const key = String(call.args.key || '').trim();
  const scope = call.args.scope === 'user' ? 'user' : 'workspace';
  if (!key) throw new Error('key es requerida');
  const ref = memoryDocRef(ctx.uid, ctx.workspaceId, scope as 'user' | 'workspace');
  await ref.set({ [`memories.${key}`]: FieldValue.delete() }, { merge: true });
  return ok(call, `Memoria "${key}" eliminada de scope ${scope}.`, { key, scope });
}

const idempotencyCache = new Map<string, { result: AgentToolExecutionResult; createdAt: number }>();
const IDEMPOTENCY_TTL_MS = 60_000;

export function getCachedToolResult(call: AgentToolCall, ctx: AgentExecutionContext): AgentToolExecutionResult | null {
  if (!call.id) return null;
  const cacheKey = `${ctx.uid}:${ctx.workspaceId}:${call.name}:${call.id}`;
  const entry = idempotencyCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > IDEMPOTENCY_TTL_MS) {
    idempotencyCache.delete(cacheKey);
    return null;
  }
  return entry.result;
}

export function setCachedToolResult(call: AgentToolCall, ctx: AgentExecutionContext, result: AgentToolExecutionResult): void {
  if (!call.id) return;
  const cacheKey = `${ctx.uid}:${ctx.workspaceId}:${call.name}:${call.id}`;
  idempotencyCache.set(cacheKey, { result, createdAt: Date.now() });
  if (idempotencyCache.size > 500) {
    const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
    for (const [k, v] of idempotencyCache.entries()) {
      if (v.createdAt < cutoff) idempotencyCache.delete(k);
    }
  }
}

export const AGENT_CONTROL_TOOL_HANDLERS: Record<string, ToolHandler> = {
  agent_plan_set: agentPlanSet,
  agent_plan_update_step: agentPlanUpdateStep,
  agent_plan_get: agentPlanGet,
  agent_plan_clear: agentPlanClear,
  agent_remember: agentRemember,
  agent_recall_memory: agentRecallMemory,
  agent_list_memories: agentListMemories,
  agent_forget: agentForget
};

void clamp;
