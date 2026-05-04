/**
 * GET /api/cron/drain-outbox
 *
 * Reintenta publicar a RTDB los pings de syncEventsOutbox marcados como
 * `published: false`. Cubre el caso en que `emitPing` no pudo escribir a
 * RTDB (red caída, rule rechazo) y solo dejó el outbox.
 *
 * Protegido por CRON_SECRET (Vercel cron o ejecución manual).
 * Pensado para ejecutarse cada 1-5 min vía vercel.json crons.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminDb } from '@/lib/firebase-admin';
import { getDatabase } from 'firebase-admin/database';
import { FieldValue } from 'firebase-admin/firestore';
import { getErrorMessage } from '@/lib/error-utils';
import { parseOutboxRecord } from '@agora/contracts';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_DRAIN = 200;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_RETRIES = 5;

export async function GET(req: NextRequest) {
    const authHeader = req.headers.get('authorization') ?? '';
    const cronSecret = env.CRON_SECRET();
    const ok = Boolean(cronSecret && authHeader === `Bearer ${cronSecret}`);
    if (!ok) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const cutoff = Date.now() - MAX_AGE_MS;
        const snap = await adminDb
            .collection('syncEventsOutbox')
            .where('published', '==', false)
            .limit(MAX_DRAIN)
            .get();

        let drained = 0, expired = 0, failed = 0;
        for (const d of snap.docs) {
            const parsed = parseOutboxRecord(d.id, d.data());
            if (!parsed.ok) {
                await d.ref.update({
                    expiredAt: FieldValue.serverTimestamp(),
                    expiredReason: `parse:${parsed.error.slice(0, 80)}`
                }).catch(() => undefined);
                expired++;
                continue;
            }
            const rec = parsed.value;

            if (rec.ts < cutoff || rec.retryCount >= MAX_RETRIES) {
                await d.ref.update({
                    expiredAt: FieldValue.serverTimestamp(),
                    expiredReason: rec.ts < cutoff ? 'too-old' : 'max-retries'
                }).catch(() => undefined);
                expired++;
                continue;
            }

            try {
                await getDatabase().ref(rec.rtdbPath).push().set(rec.payload);
                await d.ref.update({
                    published: true,
                    publishedAt: FieldValue.serverTimestamp()
                });
                drained++;
            } catch (e) {
                failed++;
                await d.ref.update({
                    retryCount: rec.retryCount + 1,
                    lastRetryAt: FieldValue.serverTimestamp(),
                    lastError: getErrorMessage(e).slice(0, 200)
                }).catch(() => undefined);
            }
        }

        if (drained || failed || expired) {
            console.info('[cron/drain-outbox]', { drained, failed, expired, total: snap.size });
        }
        return NextResponse.json({ drained, failed, expired, total: snap.size });
    } catch (e) {
        console.error('[cron/drain-outbox] error:', getErrorMessage(e));
        return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
    }
}
