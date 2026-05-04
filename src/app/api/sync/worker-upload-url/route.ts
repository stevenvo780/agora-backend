/**
 * POST /api/sync/worker-upload-url
 * Body: { repoPath: string, contentType?: string }
 * Devuelve un signed PUT URL para subir el blob a MinIO. Auth HMAC worker.
 *
 * El repoPath es relativo al workspace (sin prefijo `workspaces/<wsId>/`).
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { verifyWorkerAuth } from '@/lib/worker-auth';
import { presignPut, isNasConfigured } from '@/lib/nas-storage';
import { isPersonalWorkspaceId } from '@/types/workspace';
import { getErrorMessage } from '@/lib/error-utils';
import { sanitizeRepoPath } from '@agora/contracts';

const PUT_TTL = 15 * 60;

export async function POST(req: NextRequest) {
    try {
        if (!isNasConfigured()) return NextResponse.json({ error: 'NAS not configured' }, { status: 503 });
        const ctx = verifyWorkerAuth(req);
        if (!ctx) return NextResponse.json({ error: 'Worker auth required' }, { status: 401 });
        if (isPersonalWorkspaceId(ctx.workspaceId) && !ctx.userId) {
            return NextResponse.json({ error: 'Personal workspace requires X-Worker-Uid' }, { status: 400 });
        }

        const body = await req.json().catch(() => null) as { repoPath?: unknown; contentType?: unknown } | null;
        const repoPath = sanitizeRepoPath(body?.repoPath);
        if (!repoPath) return NextResponse.json({ error: 'Invalid repoPath' }, { status: 400 });

        const storagePath = ctx.userId
            ? `users/${ctx.userId}/${repoPath}`
            : `workspaces/${ctx.workspaceId}/${repoPath}`;
        const contentType = typeof body?.contentType === 'string' ? body.contentType : undefined;
        const url = await presignPut(storagePath, PUT_TTL, contentType);

        return NextResponse.json({ storagePath, signedUrl: url, ttlSeconds: PUT_TTL });
    } catch (e) {
        console.error('[sync/worker-upload-url] error:', getErrorMessage(e));
        return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
    }
}
