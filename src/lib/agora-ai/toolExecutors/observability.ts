import {
  type AgentToolCall, type AgentExecutionContext, type AgentToolExecutionResult,
  ok, clamp, adminDb, isPersonalWorkspaceId, fetchWorkspaceDoc
} from './shared';

type ToolHandler = (call: AgentToolCall, ctx: AgentExecutionContext) => Promise<AgentToolExecutionResult>;

async function listRecentActions(call: AgentToolCall, ctx: AgentExecutionContext) {
  const limit = clamp(typeof call.args.limit === 'number' ? call.args.limit : 20, 1, 100);
  const sinceMs = typeof call.args.sinceMs === 'number' ? call.args.sinceMs : 0;
  let query: FirebaseFirestore.Query = adminDb.collection('agentAuditLog')
    .where('uid', '==', ctx.uid)
    .where('workspaceId', '==', ctx.workspaceId);
  if (sinceMs > 0) query = query.where('createdAt', '>=', new Date(sinceMs));
  const snap = await query.orderBy('createdAt', 'desc').limit(limit).get().catch(() => null);
  if (!snap) {
    return ok(call, 'Audit log no disponible (colección agentAuditLog inexistente o sin índice).', { actions: [] });
  }
  const actions = snap.docs.map(d => {
    const data = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      tool: typeof data.tool === 'string' ? data.tool : '',
      ok: typeof data.ok === 'boolean' ? data.ok : null,
      summary: typeof data.summary === 'string' ? data.summary.slice(0, 200) : null,
      durationMs: typeof data.durationMs === 'number' ? data.durationMs : null,
      createdAt: data.createdAt
    };
  });
  return ok(call, `Últimas ${actions.length} acción(es) del agente para este workspace.`, { actions });
}

async function getAgentAuditLog(call: AgentToolCall, ctx: AgentExecutionContext) {
  const limit = clamp(typeof call.args.limit === 'number' ? call.args.limit : 50, 1, 200);
  const tool = typeof call.args.tool === 'string' ? call.args.tool : null;
  let query: FirebaseFirestore.Query = adminDb.collection('agentAuditLog')
    .where('uid', '==', ctx.uid)
    .where('workspaceId', '==', ctx.workspaceId);
  if (tool) query = query.where('tool', '==', tool);
  const snap = await query.orderBy('createdAt', 'desc').limit(limit).get().catch(() => null);
  if (!snap) {
    return ok(call, 'Audit log persistido no disponible aún. El agente registra cada tool call vía writeAuditLog en memoria + Firestore best-effort.', { entries: [] });
  }
  const entries = snap.docs.map(d => ({ id: d.id, ...(d.data() as Record<string, unknown>) }));
  return ok(call, `${entries.length} entrada(s) de audit log${tool ? ` para tool=${tool}` : ''}.`, { entries });
}

async function getSubscriptionStatus(call: AgentToolCall, ctx: AgentExecutionContext) {
  const userSnap = await adminDb.collection('users').doc(ctx.uid).get();
  if (!userSnap.exists) return ok(call, 'No hay registro de suscripción para este user.', { plan: 'free', subscription: null });
  const data = userSnap.data() as Record<string, unknown>;
  const plan = typeof data.plan === 'string' ? data.plan : 'free';
  const subscription = (data.subscription || null) as Record<string, unknown> | null;
  return ok(call, `Plan actual: ${plan}.`, {
    plan,
    subscription: subscription ? {
      status: subscription.status ?? null,
      provider: subscription.provider ?? null,
      currentPeriodEnd: subscription.currentPeriodEnd ?? null
    } : null
  });
}

async function listQuota(call: AgentToolCall, ctx: AgentExecutionContext) {
  const docsSnap = await adminDb.collection('documents')
    .where(isPersonalWorkspaceId(ctx.workspaceId) ? 'ownerId' : 'workspaceId', '==',
      isPersonalWorkspaceId(ctx.workspaceId) ? ctx.uid : ctx.workspaceId)
    .count().get().catch(() => null);
  const docCount = docsSnap?.data().count ?? 0;
  let workspacesCount = 1;
  try {
    const wsSnap = await adminDb.collection('workspaces').where('members', 'array-contains', ctx.uid).count().get();
    workspacesCount = wsSnap.data().count;
  } catch { /* ignore */ }
  let totalSizeBytes = 0;
  try {
    const sizeSnap = await adminDb.collection('documents')
      .where(isPersonalWorkspaceId(ctx.workspaceId) ? 'ownerId' : 'workspaceId', '==',
        isPersonalWorkspaceId(ctx.workspaceId) ? ctx.uid : ctx.workspaceId)
      .select('size').limit(2000).get();
    for (const d of sizeSnap.docs) {
      const s = d.data().size;
      if (typeof s === 'number') totalSizeBytes += s;
    }
  } catch { /* ignore */ }
  return ok(call, `Documentos en este workspace: ${docCount}. Workspaces accesibles: ${workspacesCount}. Tamaño aprox: ${(totalSizeBytes / 1024).toFixed(1)} KB.`, {
    workspaceId: ctx.workspaceId,
    documentCount: docCount,
    workspacesAccessible: workspacesCount,
    storageBytesUsed: totalSizeBytes,
    note: 'Las cuotas duras (límites por plan) no están publicadas como tool aún; este conteo es informativo.'
  });
}

async function getWorkspaceQuotaDetail(call: AgentToolCall, ctx: AgentExecutionContext) {
  const workspace = await fetchWorkspaceDoc(ctx.workspaceId, ctx.uid);
  return ok(call, `Detalle de quota del workspace "${workspace.name}".`, {
    workspaceId: ctx.workspaceId,
    name: workspace.name,
    type: workspace.type ?? 'shared',
    plan: typeof workspace.plan === 'string' ? workspace.plan : 'default'
  });
}

async function inspectSyncOutbox(call: AgentToolCall, ctx: AgentExecutionContext) {
  const limit = clamp(typeof call.args.limit === 'number' ? call.args.limit : 20, 1, 100);
  const snap = await adminDb.collection('syncEventsOutbox')
    .where('workspaceId', '==', ctx.workspaceId)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get()
    .catch(() => null);
  if (!snap) {
    return ok(call, 'No se pudo leer syncEventsOutbox (puede no haber índice o estar vacía).', { entries: [] });
  }
  const entries = snap.docs.map(d => {
    const data = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      type: data.type ?? null,
      path: data.path ?? null,
      retryCount: data.retryCount ?? 0,
      lastError: data.lastError ?? null,
      createdAt: data.createdAt ?? null,
      expiresAt: data.expiresAt ?? null
    };
  });
  return ok(call, `${entries.length} evento(s) en outbox del workspace.`, { entries });
}

async function forceEmitSyncPing(call: AgentToolCall, ctx: AgentExecutionContext) {
  const op = String(call.args.op || 'refresh').trim();
  const path = typeof call.args.path === 'string' ? call.args.path : '';
  if (!['created', 'updated', 'deleted', 'refresh'].includes(op)) throw new Error('op debe ser created|updated|deleted|refresh');
  const { emitPing } = await import('@/lib/nas-events');
  await emitPing({
    scope: 'workspace',
    workspaceId: ctx.workspaceId,
    op: op as 'created' | 'updated' | 'deleted' | 'refresh',
    path: path || null,
    sender: 'agent'
  }).catch(() => undefined);
  return ok(call, `Emití ping RTDB op=${op} para ${ctx.workspaceId}${path ? ` (${path})` : ''}.`, { workspaceId: ctx.workspaceId, op, path });
}

async function getDocumentSyncState(call: AgentToolCall, ctx: AgentExecutionContext) {
  const documentId = String(call.args.documentId || '').trim();
  if (!documentId) throw new Error('documentId es requerido');
  const docSnap = await adminDb.collection('documents').doc(documentId).get();
  if (!docSnap.exists) throw new Error('Documento no encontrado');
  const data = docSnap.data() as Record<string, unknown>;
  if (data.workspaceId !== ctx.workspaceId && data.workspaceId !== 'personal') {
    throw new Error('Documento de otro workspace');
  }
  const hasStorage = Boolean(data.storagePath);
  const hasContent = typeof data.content === 'string' && data.content.length > 0;
  let state: 'synced' | 'storage-only' | 'firestore-only' | 'empty';
  if (hasStorage && hasContent) state = 'synced';
  else if (hasStorage) state = 'storage-only';
  else if (hasContent) state = 'firestore-only';
  else state = 'empty';
  return ok(call, `Estado sync de "${data.name || 'Sin título'}": ${state}.`, {
    documentId, state,
    hasStorage, hasContent,
    storagePath: data.storagePath ?? null,
    firestoreContentBytes: hasContent ? (data.content as string).length : 0,
    storedSize: typeof data.size === 'number' ? data.size : null,
    updatedAt: data.updatedAt ?? null
  });
}

export const OBSERVABILITY_TOOL_HANDLERS: Record<string, ToolHandler> = {
  list_recent_actions: listRecentActions,
  get_agent_audit_log: getAgentAuditLog,
  get_subscription_status: getSubscriptionStatus,
  list_quota: listQuota,
  get_workspace_quota_detail: getWorkspaceQuotaDetail,
  inspect_sync_outbox: inspectSyncOutbox,
  force_emit_sync_ping: forceEmitSyncPing,
  get_document_sync_state: getDocumentSyncState
};
