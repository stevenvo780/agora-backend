/**
 * POST /api/sync/worker-delete
 * Body: { repoPath: string }
 * Auth: HMAC worker.
 *
 * Borra el blob en MinIO y el doc Firestore correspondiente al repoPath
 * dado dentro del workspace del worker. Pensado para limpiar zombies y
 * para futuras propagaciones de delete worker→NAS.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { verifyWorkerAuth } from '@/lib/worker-auth';
import { adminDb } from '@/lib/firebase-admin';
import { deleteObject, isNasConfigured } from '@/lib/nas-storage';
import { isPersonalWorkspaceId, PERSONAL_WORKSPACE_ID } from '@/types/workspace';
import { emitPing } from '@/lib/nas-events';
import { getErrorMessage } from '@/lib/error-utils';
import { sanitizeRepoPath, splitRepoPath } from '@agora/contracts';

export async function POST(req: NextRequest) {
    try {
        if (!isNasConfigured()) return NextResponse.json({ error: 'NAS not configured' }, { status: 503 });
        const ctx = verifyWorkerAuth(req);
        if (!ctx) return NextResponse.json({ error: 'Worker auth required' }, { status: 401 });
        const isPersonal = isPersonalWorkspaceId(ctx.workspaceId);
        if (isPersonal && !ctx.userId) {
            return NextResponse.json({ error: 'Personal workspace requires X-Worker-Uid' }, { status: 400 });
        }

        const body = await req.json() as { repoPath?: unknown };
        const repoPath = sanitizeRepoPath(body.repoPath);
        if (!repoPath) return NextResponse.json({ error: 'Invalid repoPath' }, { status: 400 });

        const { folder, name } = splitRepoPath(repoPath);

        const query = isPersonal
            ? adminDb.collection('documents')
                .where('ownerId', '==', ctx.userId)
                .where('workspaceId', '==', PERSONAL_WORKSPACE_ID)
                .where('name', '==', name)
                .where('folder', '==', folder)
            : adminDb.collection('documents')
                .where('workspaceId', '==', ctx.workspaceId)
                .where('name', '==', name)
                .where('folder', '==', folder);
        const snap = await query.limit(1).get();

        let docId: string | null = null;
        let storagePath: string | null = null;
        if (!snap.empty) {
            const ref = snap.docs[0].ref;
            const data = snap.docs[0].data() as { storagePath?: string };
            docId = ref.id;
            storagePath = typeof data.storagePath === 'string' ? data.storagePath : null;
            await ref.delete();
        }

        const blobPath = storagePath ?? (isPersonal
            ? `users/${ctx.userId}/${repoPath}`
            : `workspaces/${ctx.workspaceId}/${repoPath}`);
        await deleteObject(blobPath).catch((e) => console.warn('[worker-delete] blob delete failed:', getErrorMessage(e)));

        await emitPing({
            scope: 'document',
            op: 'deleted',
            workspaceId: ctx.workspaceId,
            docId: docId ?? undefined,
            path: blobPath,
            folder,
            sender: `worker:${ctx.workspaceId}`
        }).catch(() => undefined);

        return NextResponse.json({ ok: true, docId, blobPath });
    } catch (e) {
        console.error('[sync/worker-delete] error:', getErrorMessage(e));
        return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
    }
}
