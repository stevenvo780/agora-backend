/**
 * GET    /api/workspaces/[id]/remotes/[remoteId]   → detalles (sin secret).
 * PATCH  /api/workspaces/[id]/remotes/[remoteId]   → enabled/name/auth re-set.
 * DELETE /api/workspaces/[id]/remotes/[remoteId]   → elimina remote + secret.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminDb } from '@/lib/firebase-admin';
import { requireAuth, isAdminUser, isWorkspaceMember } from '@/lib/server-auth';
import { WorkspaceType, isPersonalWorkspaceId } from '@/types/workspace';
import { getErrorMessage } from '@/lib/error-utils';
import { encryptSecret, isVaultConfigured } from '@/lib/git-remotes/secret-vault';
import {
  parseRemotePatch,
  toPublicRemote,
  type WorkspaceRemoteRecord
} from '@/lib/git-remotes/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

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

const canView = async (ws: WorkspaceShape | undefined, uid: string, wsId: string): Promise<boolean> => {
  if (isPersonalWorkspaceId(wsId)) return true;
  if (!ws) return false;
  if (ws.ownerId === uid) return true;
  if ((ws.members ?? []).includes(uid)) return true;
  if (await isWorkspaceMember(wsId, uid)) return true;
  return isAdminUser(uid);
};

const loadWorkspace = async (workspaceId: string): Promise<WorkspaceShape | undefined> => {
  if (isPersonalWorkspaceId(workspaceId)) return { type: WorkspaceType.Personal };
  const snap = await adminDb.collection('workspaces').doc(workspaceId).get();
  if (!snap.exists) return undefined;
  return snap.data() as WorkspaceShape;
};

const remoteRef = (workspaceId: string, remoteId: string) =>
  adminDb.collection('workspaces').doc(workspaceId).collection('remotes').doc(remoteId);

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

export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    const auth = await requireAuth(req);
    if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    const { id: workspaceId, remoteId } = await ctx.params;

    const ws = await loadWorkspace(workspaceId);
    if (!ws && !isPersonalWorkspaceId(workspaceId)) return NextResponse.json({ error: 'Workspace no encontrado' }, { status: 404 });
    if (!(await canView(ws, auth.uid, workspaceId))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const snap = await remoteRef(workspaceId, remoteId).get();
    if (!snap.exists) return NextResponse.json({ error: 'Remote no encontrado' }, { status: 404 });
    const rec = recordFromDoc(snap.id, snap.data() ?? {}, workspaceId);
    return NextResponse.json({ remote: toPublicRemote(rec) });
  } catch (e) {
    console.error('[remotes/:id:GET] error', getErrorMessage(e));
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, ctx: RouteContext) {
  try {
    const auth = await requireAuth(req);
    if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    const { id: workspaceId, remoteId } = await ctx.params;

    const ws = await loadWorkspace(workspaceId);
    if (!ws && !isPersonalWorkspaceId(workspaceId)) return NextResponse.json({ error: 'Workspace no encontrado' }, { status: 404 });
    if (!(await canManage(ws, auth.uid, workspaceId))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const body = await req.json().catch(() => null);
    const parsed = parseRemotePatch(body);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const docRef = remoteRef(workspaceId, remoteId);
    const snap = await docRef.get();
    if (!snap.exists) return NextResponse.json({ error: 'Remote no encontrado' }, { status: 404 });

    const update: Record<string, unknown> = { updatedAt: Date.now() };
    if (parsed.value.name !== undefined) update.name = parsed.value.name;
    if (parsed.value.enabled !== undefined) update.enabled = parsed.value.enabled;
    if (parsed.value.authMethod !== undefined) update.authMethod = parsed.value.authMethod;

    if (parsed.value.authData !== undefined) {
      if (!isVaultConfigured()) {
        return NextResponse.json({ error: 'Vault no configurado' }, { status: 503 });
      }
      const enc = encryptSecret(parsed.value.authData);
      update.authRef = enc.ref;
      update.encryptedSecret = enc.ciphertext;
    }

    await docRef.update(update);
    const fresh = await docRef.get();
    const rec = recordFromDoc(fresh.id, fresh.data() ?? {}, workspaceId);
    return NextResponse.json({ remote: toPublicRemote(rec) });
  } catch (e) {
    console.error('[remotes/:id:PATCH] error', getErrorMessage(e));
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, ctx: RouteContext) {
  try {
    const auth = await requireAuth(req);
    if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    const { id: workspaceId, remoteId } = await ctx.params;

    const ws = await loadWorkspace(workspaceId);
    if (!ws && !isPersonalWorkspaceId(workspaceId)) return NextResponse.json({ error: 'Workspace no encontrado' }, { status: 404 });
    if (!(await canManage(ws, auth.uid, workspaceId))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const docRef = remoteRef(workspaceId, remoteId);
    const snap = await docRef.get();
    if (!snap.exists) return NextResponse.json({ error: 'Remote no encontrado' }, { status: 404 });

    await docRef.delete();
    return NextResponse.json({ status: 'deleted', remoteId });
  } catch (e) {
    console.error('[remotes/:id:DELETE] error', getErrorMessage(e));
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
