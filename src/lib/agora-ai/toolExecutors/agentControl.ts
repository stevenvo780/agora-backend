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

async function spawnSubagent(call: AgentToolCall, _ctx: AgentExecutionContext) {
  const task = String(call.args.task || '').trim();
  const scope = String(call.args.scope || 'read-only').trim();
  const maxIterations = clamp(typeof call.args.maxIterations === 'number' ? call.args.maxIterations : 5, 1, 15);
  if (!task) throw new Error('task es requerido');
  if (!['read-only', 'workspace', 'full'].includes(scope)) throw new Error('scope debe ser read-only|workspace|full');
  // Stub honesto: la spawn de subagentes reales requiere otra invocación al
  // provider con un budget separado. Hoy devolvemos contrato + sugerencia.
  return ok(call, `Subagent task "${task.slice(0, 60)}" (scope=${scope}, maxIter=${maxIterations}) pendiente — el provider del agente principal debe re-invocarse con un context limitado. Por ahora, ejecuta los pasos en línea con plan_set/plan_update.`, {
    task, scope, maxIterations,
    notImplementedFully: true,
    suggestion: 'usa agent_plan_set + ejecutar pasos con tu propio loop; cuando se implemente real spawn, esta tool re-invocará al provider con context aislado.'
  });
}

const hooksDocRef = (uid: string) => adminDb.collection('users').doc(uid).collection('agentHooks').doc('config');

async function agentSetHooks(call: AgentToolCall, ctx: AgentExecutionContext) {
  const preToolUse = Array.isArray(call.args.preToolUse) ? call.args.preToolUse : [];
  const postToolUse = Array.isArray(call.args.postToolUse) ? call.args.postToolUse : [];
  const userPromptSubmit = Array.isArray(call.args.userPromptSubmit) ? call.args.userPromptSubmit : [];
  const confirmed = call.args.confirmed === true;
  if (!confirmed) {
    return {
      ok: false,
      name: call.name,
      callId: call.id,
      summary: `¿Configurar hooks: ${preToolUse.length} preToolUse, ${postToolUse.length} postToolUse, ${userPromptSubmit.length} userPromptSubmit?`,
      pendingConfirmation: {
        toolCallId: call.id, toolName: call.name,
        prompt: 'Configurar hooks de validación del agente',
        args: { preToolUse, postToolUse, userPromptSubmit, confirmed: true }
      }
    } as AgentToolExecutionResult;
  }
  await hooksDocRef(ctx.uid).set({
    preToolUse, postToolUse, userPromptSubmit,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: false });
  return ok(call, `Hooks configurados: ${preToolUse.length} pre, ${postToolUse.length} post, ${userPromptSubmit.length} submit.`, {
    preToolUse, postToolUse, userPromptSubmit
  });
}

async function agentListHooks(call: AgentToolCall, ctx: AgentExecutionContext) {
  const snap = await hooksDocRef(ctx.uid).get();
  if (!snap.exists) return ok(call, 'No hay hooks configurados.', { hooks: null });
  const data = snap.data() as Record<string, unknown>;
  return ok(call, 'Hooks configurados.', { hooks: data });
}

const turnSnapshotRef = (uid: string, turnId: string) => adminDb.collection('users').doc(uid).collection('agentTurnSnapshots').doc(turnId);

async function agentSaveTurnSnapshot(call: AgentToolCall, ctx: AgentExecutionContext) {
  const turnId = String(call.args.turnId || `turn-${Date.now()}`).trim();
  const summary = typeof call.args.summary === 'string' ? call.args.summary : '';
  const messages = Array.isArray(call.args.messages) ? call.args.messages : [];
  const toolCalls = Array.isArray(call.args.toolCalls) ? call.args.toolCalls : [];
  await turnSnapshotRef(ctx.uid, turnId).set({
    workspaceId: ctx.workspaceId,
    summary: summary.slice(0, 500),
    messages, toolCalls,
    createdAt: FieldValue.serverTimestamp()
  }, { merge: false });
  return ok(call, `Turn snapshot guardado: ${turnId}.`, { turnId });
}

async function agentListTurnSnapshots(call: AgentToolCall, ctx: AgentExecutionContext) {
  const limit = clamp(typeof call.args.limit === 'number' ? call.args.limit : 20, 1, 100);
  const snap = await adminDb.collection('users').doc(ctx.uid).collection('agentTurnSnapshots')
    .orderBy('createdAt', 'desc').limit(limit).get().catch(() => null);
  if (!snap) return ok(call, 'No hay snapshots.', { snapshots: [] });
  return ok(call, `${snap.size} snapshot(s) disponibles.`, {
    snapshots: snap.docs.map(d => ({
      turnId: d.id,
      summary: (d.data() as { summary?: string }).summary ?? '',
      createdAt: (d.data() as { createdAt?: unknown }).createdAt ?? null
    }))
  });
}

async function agentClearTurnSnapshot(call: AgentToolCall, ctx: AgentExecutionContext) {
  const turnId = String(call.args.turnId || '').trim();
  if (!turnId) throw new Error('turnId es requerido');
  await turnSnapshotRef(ctx.uid, turnId).delete().catch(() => undefined);
  return ok(call, `Snapshot ${turnId} eliminado.`, { turnId });
}

async function agentDryRunInfo(call: AgentToolCall, ctx: AgentExecutionContext) {
  const dryRun = (ctx as unknown as Record<string, unknown>).dryRun === true;
  return ok(call, dryRun
    ? 'Modo dry-run ACTIVO: tools destructivas no aplican cambios reales.'
    : 'Modo dry-run INACTIVO: las tools destructivas aplican cambios reales.', {
    dryRun,
    note: 'Para activar dry-run el cliente debe enviar dryRun:true en el body del stream/request.'
  });
}

export const AGENT_CONTROL_TOOL_HANDLERS: Record<string, ToolHandler> = {
  agent_plan_set: agentPlanSet,
  agent_plan_update_step: agentPlanUpdateStep,
  agent_plan_get: agentPlanGet,
  agent_plan_clear: agentPlanClear,
  agent_remember: agentRemember,
  agent_recall_memory: agentRecallMemory,
  agent_list_memories: agentListMemories,
  agent_forget: agentForget,
  spawn_subagent: spawnSubagent,
  agent_set_hooks: agentSetHooks,
  agent_list_hooks: agentListHooks,
  agent_save_turn_snapshot: agentSaveTurnSnapshot,
  agent_list_turn_snapshots: agentListTurnSnapshots,
  agent_clear_turn_snapshot: agentClearTurnSnapshot,
  agent_dry_run_info: agentDryRunInfo
};
