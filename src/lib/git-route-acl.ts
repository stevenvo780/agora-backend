/**
 * Helper compartido para los endpoints `/api/workspaces/[id]/git/*`.
 * Centraliza el patrón de auth + ACL workspace + resolución del nombre
 * del repo Forgejo. Evita duplicar el bloque en cada handler.
 */
import type { NextRequest } from '@/lib/http/next-server';
import { requireAuth, isWorkspaceMember } from '@/lib/server-auth';
import { adminDb } from '@/lib/firebase-admin';
import { isPersonalWorkspaceId } from '@/types/workspace';
import { isForgejoConfigured, repoNameForWorkspace, getForgejoOrg } from '@/lib/forgejo';

export interface GitRouteAclOk {
  ok: true;
  auth: { uid: string };
  ownerUid: string;
  repoFullName: string;
}

export interface GitRouteAclErr {
  ok: false;
  status: number;
  error: string;
}

export type GitRouteAclResult = GitRouteAclOk | GitRouteAclErr;

export async function authorizeGitRoute(
  req: NextRequest,
  workspaceId: string
): Promise<GitRouteAclResult> {
  if (!isForgejoConfigured()) {
    return { ok: false, status: 503, error: 'Forgejo not configured' };
  }
  const auth = await requireAuth(req);
  if (!auth) return { ok: false, status: 401, error: 'No autorizado' };

  let ownerUid = auth.uid;
  if (!isPersonalWorkspaceId(workspaceId)) {
    const ws = await adminDb.collection('workspaces').doc(workspaceId).get();
    if (!ws.exists) return { ok: false, status: 404, error: 'Workspace not found' };
    const data = ws.data() as { ownerId?: string; members?: string[] } | undefined;
    const isMember = (data?.members ?? []).includes(auth.uid)
      || data?.ownerId === auth.uid
      || (await isWorkspaceMember(workspaceId, auth.uid));
    if (!isMember) return { ok: false, status: 403, error: 'Forbidden' };
    ownerUid = data?.ownerId ?? auth.uid;
  }

  const repoName = repoNameForWorkspace(workspaceId, ownerUid);
  const repoFullName = `${getForgejoOrg()}/${repoName}`;
  return { ok: true, auth: { uid: auth.uid }, ownerUid, repoFullName };
}
