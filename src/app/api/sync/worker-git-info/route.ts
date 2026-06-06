/**
 * GET /api/sync/worker-git-info
 *
 * Devuelve credenciales git efímeras para que un worker configure su remote
 * Forgejo on-demand (auth HMAC worker, ver lib/worker-auth). El token vive sólo
 * dentro del git config del container — nunca se inyecta por env ni aparece en
 * `docker inspect`. El sync continuo de /workspace lo sigue haciendo el daemon
 * MinIO; este remote es para que el usuario/agente haga git pull/push cuando
 * quiera.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { verifyWorkerAuth } from '@/lib/worker-auth';
import { adminDb } from '@/lib/firebase-admin';
import { isPersonalWorkspaceId } from '@/types/workspace';
import { isForgejoConfigured, getWorkerGitCreds } from '@/lib/forgejo';
import { getErrorMessage } from '@/lib/error-utils';

export async function GET(req: NextRequest) {
  try {
    if (!isForgejoConfigured()) {
      return NextResponse.json({ error: 'Forgejo not configured' }, { status: 503 });
    }
    const ctx = verifyWorkerAuth(req);
    if (!ctx) return NextResponse.json({ error: 'Worker auth required' }, { status: 401 });

    const isPersonal = isPersonalWorkspaceId(ctx.workspaceId);
    if (isPersonal && !ctx.userId) {
      return NextResponse.json({ error: 'Personal workspace requires X-Worker-Uid' }, { status: 400 });
    }

    let ownerUid = ctx.userId ?? '';
    let workspaceName: string | undefined;
    if (!isPersonal) {
      const wsSnap = await adminDb.collection('workspaces').doc(ctx.workspaceId).get();
      const data = wsSnap.data() as { ownerId?: string; name?: string } | undefined;
      ownerUid = data?.ownerId ?? '';
      workspaceName = data?.name;
    }
    if (!ownerUid) {
      return NextResponse.json(
        { error: 'Workspace not found in Firestore', wsId: ctx.workspaceId, code: 'WORKSPACE_NOT_FOUND' },
        { status: 404 }
      );
    }

    const creds = await getWorkerGitCreds({
      workspaceId: ctx.workspaceId,
      ownerUid,
      isPersonal,
      userId: ctx.userId,
      workspaceName
    });
    if (!creds) {
      return NextResponse.json({ error: 'Could not issue Forgejo credentials' }, { status: 502 });
    }

    return NextResponse.json(creds);
  } catch (e) {
    console.error('[sync/worker-git-info] error:', getErrorMessage(e));
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
