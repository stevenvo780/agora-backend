/**
 * POST /api/diag/sync-test
 *
 * Validador end-to-end del bus RTDB:
 *  1. Emite un ping con `emitPing()` al canal personal del usuario.
 *  2. Lee de vuelta el outbox para confirmar `published: true`.
 *  3. Lee directamente desde RTDB el último child del canal y verifica que
 *     coincide con lo que se emitió.
 *
 * Si los 3 pasos pasan, el bus está sano. Si (3) falla pero (1+2) pasan, el
 * problema está en el listener cliente, no en el server.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth } from '@/lib/server-auth';
import { emitPing } from '@/lib/nas-events';
import { adminDb } from '@/lib/firebase-admin';
import { getDatabase } from 'firebase-admin/database';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
    try {
        const auth = await requireAuth(req);
        if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

        const tStart = Date.now();
        const result = await emitPing({
            scope: 'user',
            op: 'refresh',
            userId: auth.uid,
            path: '__diag__',
            sender: 'diag-sync-test'
        });
        const tEmit = Date.now() - tStart;

        // (2) Outbox status
        const snap = await adminDb.collection('syncEventsOutbox').doc(result.outboxId).get();
        const outboxData = snap.exists ? snap.data() : null;
        const published = outboxData?.published === true;

        // (3) RTDB tail read: traer el último mensaje del canal y verificar.
        const rtdbTail: { ok: boolean; matchedTimestamp?: number; sampleKeys?: string[]; error?: string } = { ok: false };
        try {
            const tailSnap = await getDatabase()
                .ref(result.rtdbPath)
                .orderByChild('timestamp')
                .limitToLast(1)
                .once('value');
            const val = tailSnap.val() as Record<string, { timestamp?: number; type?: string; source?: string }> | null;
            const last = val ? Object.values(val)[0] : null;
            if (last) {
                rtdbTail.ok = true;
                rtdbTail.matchedTimestamp = last.timestamp;
                rtdbTail.sampleKeys = Object.keys(last);
            } else {
                rtdbTail.error = 'tail vacío';
            }
        } catch (e) {
            rtdbTail.error = (e as Error).message;
        }

        const tTotal = Date.now() - tStart;
        console.info('[diag/sync-test]', { uid: auth.uid, rtdbPath: result.rtdbPath, published, rtdbTail: rtdbTail.ok, tEmit, tTotal });

        return NextResponse.json({
            ok: published && rtdbTail.ok,
            outboxId: result.outboxId,
            rtdbPath: result.rtdbPath,
            outbox: { published, publishedAt: outboxData?.publishedAt ?? null },
            rtdbTail,
            timings: { emitMs: tEmit, totalMs: tTotal },
            payloadShape: outboxData ? Object.keys(outboxData) : [],
            ts: new Date().toISOString()
        });
    } catch (e) {
        const err = e as Error;
        console.error('[diag/sync-test] error:', err?.message, err?.stack?.split('\n').slice(0, 3).join(' | '));
        return NextResponse.json({ error: err?.message ?? String(e) }, { status: 500 });
    }
}
