/**
 * POST /api/workspaces/[id]/remotes/[remoteId]/push
 * Empuja el repo Forgejo del workspace al remote externo. Operación on-demand.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminDb } from '@/lib/firebase-admin';
import { requireAuth, isAdminUser } from '@/lib/server-auth';
import { WorkspaceType, isPersonalWorkspaceId } from '@/types/workspace';
import { getErrorMessage } from '@/lib/error-utils';
import { repoNameForWorkspace, isForgejoConfigured } from '@/lib/forgejo';
import { pushToExternalRemote } from '@/lib/git-remotes/git-operations';
import type { WorkspaceRemoteRecord } from '@/lib/git-remotes/types';

export const runtime = 'nodejs';
export const maxDuration = 600;

type RouteContext = { params: Promise<{ id: string; remoteId: string }> };

interface WorkspaceShape {
  ownerId?: string;
  type?: string;
  members?: string[];
}

const canManage = async (ws: WorkspaceShape | undefined, uid: string, wsId: string): Promise<boolean> => {
  if (isPersonalWorkspaceId(wsId)) return true;
  if (!ws) return false;
  if (ws.type === WorkspaceType.Personal) return false;
  if (ws.ownerId === uid) return true;
  return isAdminUser(uid);
};

const loadWorkspace = async (workspaceId: string, uid: string): Promise<{ ws: WorkspaceShape | undefined; ownerUid: string }> => {
  if (isPersonalWorkspaceId(workspaceId)) {
    return { ws: { type: WorkspaceType.Personal, ownerId: uid }, ownerUid: uid };
  }
  const snap = await adminDb.collection('workspaces').doc(workspaceId).get();
  if (!snap.exists) return { ws: undefined, ownerUid: uid };
  const data = snap.data() as WorkspaceShape;
  return { ws: data, ownerUid: data.ownerId ?? uid };
};

const recordFromDoc = (id: string, data: Record<string, unknown>, workspaceId: string): WorkspaceRemoteRecord => ({
  id,
  workspaceId,
  name: typeof data.name === 'string' ? data.name : '',
  url: typeof data.url === 'string' ? data.url : '',
  provider: (data.provider as WorkspaceRemoteRecord['provider']) ?? 'custom',
  authMethod: (data.authMethod as WorkspaceRemoteRecord['authMethod']) ?? 'none',
  authRef: typeof data.authRef === 'string' ? data.authRef : null,
  isDefault: typeof data.isDefault === 'boolean' ? data.isDefault : false,
  enabled: typeof data.enabled === 'boolean' ? data.enabled : true,
  lastSyncAt: typeof data.lastSyncAt === 'number' ? data.lastSyncAt : null,
  lastSyncStatus: (data.lastSyncStatus as WorkspaceRemoteRecord['lastSyncStatus']) ?? null,
  lastSyncError: typeof data.lastSyncError === 'string' ? data.lastSyncError : null,
  createdAt: typeof data.createdAt === 'number' ? data.createdAt : 0,
  updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0,
  createdBy: typeof data.createdBy === 'string' ? data.createdBy : ''
});

export async function POST(req: NextRequest, ctx: RouteContext) {
  try {
    if (!isForgejoConfigured()) {
      return NextResponse.json({ error: 'Forgejo no configurado' }, { status: 503 });
    }
    const auth = await requireAuth(req);
    if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    const { id: workspaceId, remoteId } = await ctx.params;

    const { ws, ownerUid } = await loadWorkspace(workspaceId, auth.uid);
    if (!ws && !isPersonalWorkspaceId(workspaceId)) {
      return NextResponse.json({ error: 'Workspace no encontrado' }, { status: 404 });
    }
    if (!(await canManage(ws, auth.uid, workspaceId))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const docRef = adminDb.collection('workspaces').doc(workspaceId).collection('remotes').doc(remoteId);
    const snap = await docRef.get();
    if (!snap.exists) return NextResponse.json({ error: 'Remote no encontrado' }, { status: 404 });
    const data = snap.data() ?? {};
    const remote = recordFromDoc(snap.id, data, workspaceId);
    if (!remote.enabled) return NextResponse.json({ error: 'Remote deshabilitado' }, { status: 409 });

    const encryptedSecret = typeof data.encryptedSecret === 'string' ? data.encryptedSecret : null;
    const repoName = repoNameForWorkspace(workspaceId, ownerUid);

    const body = await req.json().catch(() => null);
    const ref = typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>).ref === 'string'
      ? (body as Record<string, string>).ref
      : undefined;

    const result = await pushToExternalRemote({
      workspaceId, ownerUid, repoName, remote, encryptedSecret,
      ...(ref !== undefined ? { ref } : {})
    });

    const now = Date.now();
    await docRef.update({
      lastSyncAt: now,
      lastSyncStatus: result.ok ? 'ok' : 'error',
      lastSyncError: result.ok ? null : (result.error ?? 'unknown'),
      updatedAt: now
    }).catch((e: unknown) => console.warn('[remotes/push] no se pudo actualizar lastSync*', getErrorMessage(e)));

    if (!result.ok) {
      const status = result.notImplemented ? 501 : 502;
      return NextResponse.json({
        ok: false,
        error: result.error ?? 'push falló',
        notImplemented: !!result.notImplemented,
        durationMs: result.durationMs
      }, { status });
    }

    return NextResponse.json({ ok: true, ref: result.ref ?? null, durationMs: result.durationMs });
  } catch (e) {
    console.error('[remotes/push] error', getErrorMessage(e));
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
