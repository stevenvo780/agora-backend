/**
 * POST /api/workspaces/[id]/git/revert
 * Body: { sha: string }
 * Crea un commit nuevo que deshace los cambios del commit `sha`.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';

export const runtime = 'nodejs';

import { authorizeGitRoute } from '@/lib/git-route-acl';
import { revertCommitViaApi } from '@/lib/forgejo-history';
import { emitPing } from '@/lib/nas-events';
import { isPersonalWorkspaceId } from '@/types/workspace';
import { getErrorMessage } from '@/lib/error-utils';

export const maxDuration = 120;

const SHA_RE = /^[a-f0-9]{4,40}$/i;

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const { id: workspaceId } = await context.params;
    const acl = await authorizeGitRoute(req, workspaceId);
    if (!acl.ok) return NextResponse.json({ error: acl.error }, { status: acl.status });

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
    }
    const sha = typeof (body as { sha?: unknown })?.sha === 'string'
      ? (body as { sha: string }).sha.trim()
      : '';
    if (!SHA_RE.test(sha)) {
      return NextResponse.json({ error: 'sha hex inválido' }, { status: 400 });
    }

    const result = await revertCommitViaApi({
      repoFullName: acl.repoFullName,
      sha,
      branch: 'main',
      authorName: 'agora-revert',
      authorEmail: 'noreply@agora.local'
    });

    if (!result.ok) {
      const status = result.conflicts && result.conflicts.length > 0 ? 409 : 422;
      return NextResponse.json({
        ok: false,
        error: result.error ?? 'Revert falló',
        ...(result.conflicts ? { conflicts: result.conflicts } : {})
      }, { status });
    }

    // Best-effort: emite un ping RTDB para que clientes (web + worker)
    // sepan que el repo cambió y resincronicen. Si esto falla no
    // abortamos el revert — el daemon `agora-host-sync` también
    // detectará el cambio en su próximo ciclo (≤5s).
    try {
      await emitPing({
        scope: 'workspace',
        op: 'refresh',
        workspaceId: isPersonalWorkspaceId(workspaceId) ? null : workspaceId,
        userId: isPersonalWorkspaceId(workspaceId) ? acl.auth.uid : null,
        sender: 'git-revert'
      });
    } catch (e) {
      console.warn('[git/revert] emitPing failed:', getErrorMessage(e));
    }

    return NextResponse.json({
      ok: true,
      newSha: result.newSha,
      message: result.message,
      filesChanged: result.filesChanged ?? 0,
      ...(result.conflicts ? { conflicts: result.conflicts } : {})
    });
  } catch (e) {
    console.error('[git/revert] error:', getErrorMessage(e));
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
