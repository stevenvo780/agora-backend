import {
  type AgentToolCall, type AgentExecutionContext, type AgentToolExecutionResult,
  ok, confirm, ensureWorkspaceAccess, fetchWorkspaceDoc,
  adminDb, FieldValue, isPersonalWorkspaceId
} from './shared';

type ToolHandler = (call: AgentToolCall, ctx: AgentExecutionContext) => Promise<AgentToolExecutionResult>;

async function ensureWorkspaceOwner(workspaceId: string, uid: string) {
  if (isPersonalWorkspaceId(workspaceId)) return;
  const workspace = await fetchWorkspaceDoc(workspaceId, uid);
  if (workspace.ownerId !== uid) {
    throw new Error('Solo el owner del workspace puede ejecutar esta acción');
  }
}

async function inviteMember(call: AgentToolCall, ctx: AgentExecutionContext) {
  const memberUidOrEmail = String(call.args.userIdOrEmail || '').trim();
  const confirmed = call.args.confirmed === true;
  if (isPersonalWorkspaceId(ctx.workspaceId)) {
    throw new Error('Los workspaces personales no soportan invitar miembros');
  }
  if (!memberUidOrEmail) throw new Error('userIdOrEmail es requerido');
  await ensureWorkspaceOwner(ctx.workspaceId, ctx.uid);
  if (!confirmed) {
    return confirm(call, `¿Invitar a "${memberUidOrEmail}" como miembro de este workspace?`, { userIdOrEmail: memberUidOrEmail });
  }
  await adminDb.collection('workspaces').doc(ctx.workspaceId).update({
    pendingInvites: FieldValue.arrayUnion(memberUidOrEmail),
    updatedAt: FieldValue.serverTimestamp(),
    lastUpdatedBy: ctx.uid
  });
  return ok(call, `Añadí "${memberUidOrEmail}" a pendingInvites del workspace.`, { userIdOrEmail: memberUidOrEmail });
}

async function removeMember(call: AgentToolCall, ctx: AgentExecutionContext) {
  const targetUid = String(call.args.userId || '').trim();
  const confirmed = call.args.confirmed === true;
  if (isPersonalWorkspaceId(ctx.workspaceId)) {
    throw new Error('Los workspaces personales no soportan miembros');
  }
  if (!targetUid) throw new Error('userId es requerido');
  await ensureWorkspaceOwner(ctx.workspaceId, ctx.uid);
  const workspace = await fetchWorkspaceDoc(ctx.workspaceId, ctx.uid);
  if (workspace.ownerId === targetUid) {
    throw new Error('No puedes remover al owner. Usa transfer_workspace_ownership primero.');
  }
  if (!confirmed) {
    return confirm(call, `¿Remover al miembro "${targetUid}" del workspace?`, { userId: targetUid });
  }
  await adminDb.collection('workspaces').doc(ctx.workspaceId).update({
    members: FieldValue.arrayRemove(targetUid),
    updatedAt: FieldValue.serverTimestamp(),
    lastUpdatedBy: ctx.uid
  });
  return ok(call, `Removí al miembro "${targetUid}" del workspace.`, { userId: targetUid }, [
    { action: 'invite_member', args: { userIdOrEmail: targetUid, confirmed: true } }
  ]);
}

async function changeWorkspaceSettings(call: AgentToolCall, ctx: AgentExecutionContext) {
  if (isPersonalWorkspaceId(ctx.workspaceId)) {
    throw new Error('Los settings del workspace personal no se pueden modificar');
  }
  await ensureWorkspaceOwner(ctx.workspaceId, ctx.uid);
  const updates: Record<string, unknown> = {};
  if (typeof call.args.name === 'string' && call.args.name.trim()) updates.name = call.args.name.trim().slice(0, 200);
  if (typeof call.args.description === 'string') updates.description = call.args.description.trim().slice(0, 1000);
  if (typeof call.args.visibility === 'string' && ['private', 'shared'].includes(call.args.visibility)) {
    updates.type = call.args.visibility === 'shared' ? 'shared' : 'private';
  }
  if (Object.keys(updates).length === 0) {
    throw new Error('No se especificaron cambios (name, description o visibility)');
  }
  updates.updatedAt = FieldValue.serverTimestamp();
  updates.lastUpdatedBy = ctx.uid;
  await adminDb.collection('workspaces').doc(ctx.workspaceId).update(updates);
  return ok(call, `Actualicé los settings del workspace: ${Object.keys(updates).filter(k => k !== 'updatedAt' && k !== 'lastUpdatedBy').join(', ')}.`, { updated: updates });
}

async function transferWorkspaceOwnership(call: AgentToolCall, ctx: AgentExecutionContext) {
  const newOwner = String(call.args.newOwnerId || '').trim();
  const confirmed = call.args.confirmed === true;
  if (isPersonalWorkspaceId(ctx.workspaceId)) {
    throw new Error('No puedes transferir un workspace personal');
  }
  if (!newOwner) throw new Error('newOwnerId es requerido');
  await ensureWorkspaceOwner(ctx.workspaceId, ctx.uid);
  const workspace = await fetchWorkspaceDoc(ctx.workspaceId, ctx.uid);
  const members = Array.isArray(workspace.members) ? workspace.members as string[] : [];
  if (!members.includes(newOwner)) {
    throw new Error(`El nuevo owner "${newOwner}" debe ser miembro del workspace primero`);
  }
  if (!confirmed) {
    return confirm(call, `¿Transferir ownership del workspace "${workspace.name}" a "${newOwner}"? Tras esto perderás permisos administrativos.`, { newOwnerId: newOwner });
  }
  await adminDb.collection('workspaces').doc(ctx.workspaceId).update({
    ownerId: newOwner,
    updatedAt: FieldValue.serverTimestamp(),
    lastUpdatedBy: ctx.uid
  });
  return ok(call, `Transferí el ownership a "${newOwner}".`, { newOwnerId: newOwner, previousOwnerId: ctx.uid });
}

async function listMembers(call: AgentToolCall, ctx: AgentExecutionContext) {
  await ensureWorkspaceAccess(ctx.workspaceId, ctx.uid);
  if (isPersonalWorkspaceId(ctx.workspaceId)) {
    return ok(call, 'Workspace personal: solo el owner.', { members: [{ uid: ctx.uid, role: 'owner' }] });
  }
  const workspace = await fetchWorkspaceDoc(ctx.workspaceId, ctx.uid);
  const members = Array.isArray(workspace.members) ? workspace.members as string[] : [];
  const pendingInvites = Array.isArray(workspace.pendingInvites) ? workspace.pendingInvites as string[] : [];
  return ok(call, `${members.length} miembro(s), ${pendingInvites.length} invitación(es) pendiente(s).`, {
    ownerId: workspace.ownerId,
    members: members.map(uid => ({ uid, role: uid === workspace.ownerId ? 'owner' : 'member' })),
    pendingInvites
  });
}

async function acceptInvite(call: AgentToolCall, ctx: AgentExecutionContext) {
  const targetWorkspace = String(call.args.workspaceId || ctx.workspaceId || '').trim();
  if (!targetWorkspace || isPersonalWorkspaceId(targetWorkspace)) throw new Error('workspaceId compartido es requerido');
  const wsRef = adminDb.collection('workspaces').doc(targetWorkspace);
  const snap = await wsRef.get();
  if (!snap.exists) throw new Error('Workspace no encontrado');
  const data = snap.data() as Record<string, unknown>;
  const pending = Array.isArray(data.pendingInvites) ? data.pendingInvites as string[] : [];
  const userSnap = await adminDb.collection('users').doc(ctx.uid).get();
  const userData = userSnap.data() as Record<string, unknown> | undefined;
  const email = typeof userData?.email === 'string' ? userData.email : null;
  const isInvited = pending.includes(ctx.uid) || (email && pending.includes(email));
  if (!isInvited) throw new Error(`No estás invitado a este workspace (uid=${ctx.uid}, email=${email})`);
  await wsRef.update({
    members: FieldValue.arrayUnion(ctx.uid),
    pendingInvites: FieldValue.arrayRemove(ctx.uid, ...(email ? [email] : [])),
    updatedAt: FieldValue.serverTimestamp()
  });
  return ok(call, `Acepté la invitación al workspace "${data.name || targetWorkspace}".`, { workspaceId: targetWorkspace });
}

async function declineInvite(call: AgentToolCall, ctx: AgentExecutionContext) {
  const targetWorkspace = String(call.args.workspaceId || ctx.workspaceId || '').trim();
  if (!targetWorkspace || isPersonalWorkspaceId(targetWorkspace)) throw new Error('workspaceId compartido es requerido');
  const wsRef = adminDb.collection('workspaces').doc(targetWorkspace);
  const userSnap = await adminDb.collection('users').doc(ctx.uid).get();
  const userData = userSnap.data() as Record<string, unknown> | undefined;
  const email = typeof userData?.email === 'string' ? userData.email : null;
  await wsRef.update({
    pendingInvites: FieldValue.arrayRemove(ctx.uid, ...(email ? [email] : [])),
    updatedAt: FieldValue.serverTimestamp()
  });
  return ok(call, `Decliné la invitación al workspace ${targetWorkspace}.`, { workspaceId: targetWorkspace });
}

export const ADMIN_TOOL_HANDLERS: Record<string, ToolHandler> = {
  invite_member: inviteMember,
  remove_member: removeMember,
  change_workspace_settings: changeWorkspaceSettings,
  transfer_workspace_ownership: transferWorkspaceOwnership,
  list_members: listMembers,
  accept_invite: acceptInvite,
  decline_invite: declineInvite
};
