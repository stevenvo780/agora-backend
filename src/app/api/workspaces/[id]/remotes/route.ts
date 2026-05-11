/**
 * Remotes externos por workspace.
 *   GET  /api/workspaces/[id]/remotes        → lista remotes (sin secretos).
 *   POST /api/workspaces/[id]/remotes        → crea remote.
 *
 * Forgejo no aparece en esta colección: es el source-of-truth implícito.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminDb } from '@/lib/firebase-admin';
import { requireAuth, isAdminUser, isWorkspaceMember } from '@/lib/server-auth';
import { WorkspaceType, isPersonalWorkspaceId } from '@/types/workspace';
import { getErrorMessage } from '@/lib/error-utils';
import { encryptSecret, isVaultConfigured } from '@/lib/git-remotes/secret-vault';
import {
  parseRemoteCreate,
  toPublicRemote,
  type WorkspaceRemoteRecord
} from '@/lib/git-remotes/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

interface WorkspaceShape {
  ownerId?: string;
  type?: string;
  members?: string[];
}

const canManageRemotes = async (ws: WorkspaceShape | undefined, uid: string, wsId: string): Promise<boolean> => {
  if (isPersonalWorkspaceId(wsId)) return true;
  if (!ws) return false;
  if (ws.type === WorkspaceType.Personal) return false;
  if (ws.ownerId === uid) return true;
  if (await isAdminUser(uid)) return true;
  return false;
};

const canViewRemotes = async (ws: WorkspaceShape | undefined, uid: string, wsId: string): Promise<boolean> => {
  if (isPersonalWorkspaceId(wsId)) return true;
  if (!ws) return false;
  if (ws.ownerId === uid) return true;
  if ((ws.members ?? []).includes(uid)) return true;
  if (await isWorkspaceMember(wsId, uid)) return true;
  if (await isAdminUser(uid)) return true;
  return false;
};

const remotesCollection = (workspaceId: string) =>
  adminDb.collection('workspaces').doc(workspaceId).collection('remotes');

const loadWorkspace = async (workspaceId: string): Promise<WorkspaceShape | undefined> => {
  if (isPersonalWorkspaceId(workspaceId)) return { type: WorkspaceType.Personal };
  const snap = await adminDb.collection('workspaces').doc(workspaceId).get();
  if (!snap.exists) return undefined;
  return snap.data() as WorkspaceShape;
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

export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    const auth = await requireAuth(req);
    if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    const { id: workspaceId } = await ctx.params;
    if (!workspaceId) return NextResponse.json({ error: 'workspace id requerido' }, { status: 400 });

    const ws = await loadWorkspace(workspaceId);
    if (!ws && !isPersonalWorkspaceId(workspaceId)) {
      return NextResponse.json({ error: 'Workspace no encontrado' }, { status: 404 });
    }
    if (!(await canViewRemotes(ws, auth.uid, workspaceId))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const snap = await remotesCollection(workspaceId).orderBy('createdAt', 'asc').get();
    const remotes = snap.docs.map(d => toPublicRemote(recordFromDoc(d.id, d.data(), workspaceId)));
    return NextResponse.json({ workspaceId, remotes });
  } catch (e) {
    console.error('[remotes:GET] error', getErrorMessage(e));
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  try {
    const auth = await requireAuth(req);
    if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    const { id: workspaceId } = await ctx.params;
    if (!workspaceId) return NextResponse.json({ error: 'workspace id requerido' }, { status: 400 });

    const ws = await loadWorkspace(workspaceId);
    if (!ws && !isPersonalWorkspaceId(workspaceId)) {
      return NextResponse.json({ error: 'Workspace no encontrado' }, { status: 404 });
    }
    if (!(await canManageRemotes(ws, auth.uid, workspaceId))) {
      return NextResponse.json({ error: 'Solo owner o admin pueden gestionar remotes' }, { status: 403 });
    }

    const body = await req.json().catch(() => null);
    const parsed = parseRemoteCreate(body);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const input = parsed.value;
    if (input.authMethod !== 'none' && !isVaultConfigured()) {
      return NextResponse.json({
        error: 'Vault de secrets no configurado (falta WORKER_SECRET en backend)'
      }, { status: 503 });
    }

    let authRef: string | null = null;
    let ciphertext: string | null = null;
    if (input.authData) {
      const enc = encryptSecret(input.authData);
      authRef = enc.ref;
      ciphertext = enc.ciphertext;
    }

    const now = Date.now();
    const col = remotesCollection(workspaceId);
    const docRef = col.doc();

    const docData: Record<string, unknown> = {
      name: input.name,
      url: input.url,
      provider: input.provider,
      authMethod: input.authMethod,
      authRef,
      isDefault: false,
      enabled: true,
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null,
      createdAt: now,
      updatedAt: now,
      createdBy: auth.uid
    };
    if (ciphertext !== null) {
      docData.encryptedSecret = ciphertext;
    }

    await docRef.set(docData);

    const record = recordFromDoc(docRef.id, docData, workspaceId);
    return NextResponse.json({ remote: toPublicRemote(record) }, { status: 201 });
  } catch (e) {
    console.error('[remotes:POST] error', getErrorMessage(e));
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
