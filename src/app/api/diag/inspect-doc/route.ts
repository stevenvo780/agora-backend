/**
 * GET /api/diag/inspect-doc?id=<docId>
 * Devuelve metadata cruda del doc (storagePath, type, mime). Auth: WORKER_SECRET
 * en `Authorization: Bearer ...`. Pensado para debug puntual; no expone contenido.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminDb } from '@/lib/firebase-admin';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
    const auth = req.headers.get('authorization') ?? '';
    const expected = `Bearer ${env.WORKER_SECRET()}`;
    if (!auth || auth !== expected) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const id = new URL(req.url).searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    const snap = await adminDb.collection('documents').doc(id).get();
    if (!snap.exists) return NextResponse.json({ error: 'not found' }, { status: 404 });
    const d = snap.data() ?? {};
    return NextResponse.json({
        id,
        name: d.name ?? null,
        type: d.type ?? null,
        mimeType: d.mimeType ?? null,
        storagePath: d.storagePath ?? null,
        storageBackend: d.storageBackend ?? null,
        ownerId: d.ownerId ?? null,
        workspaceId: d.workspaceId ?? null,
        size: d.size ?? null,
        contentHash: d.contentHash ?? null,
        url: typeof d.url === 'string' ? `${d.url.slice(0, 200)}...` : null
    });
}
