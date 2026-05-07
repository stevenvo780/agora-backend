/**
 * GET /api/cron/compact-sync-events
 *
 * Borra eventos viejos de RTDB en `sync-events/<wsId>` y
 * `sync-events/personal_<uid>`. Sin compaction el árbol crece sin techo.
 *
 * Estrategia:
 *  1. Iterar páginas de `workspaces` y `users` (cap por invocación).
 *  2. Por canal, leer hijos con `orderByChild('timestamp').endAt(cutoff)`
 *     y borrar via `update({ <childKey>: null, ... })` en lotes.
 *  3. Idempotente: si corre 2 veces seguidas, la segunda no encuentra nada
 *     nuevo bajo el cutoff y no borra de más.
 *
 * Protegido por CRON_SECRET (mismo patrón que drain-outbox).
 * Pensado para correr 1x/día vía vercel.json crons.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminDb } from '@/lib/firebase-admin';
import { getDatabase } from 'firebase-admin/database';
import { getErrorMessage } from '@/lib/error-utils';
import { env } from '@/lib/env';
import { timingSafeEqual } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RETENTION_MS = 24 * 60 * 60 * 1000;        // 24h
const MAX_DELETES_PER_INVOCATION = 5000;          // cap global (timeout safety)
const MAX_WORKSPACES_PER_INVOCATION = 100;        // workspaces page
const MAX_USERS_PER_INVOCATION = 100;             // personal channels page
const RTDB_BATCH_SIZE = 500;                      // multi-path update size

const safeBearerEqual = (authHeader: string, secret: string): boolean => {
    const expected = `Bearer ${secret}`;
    const a = Buffer.from(authHeader);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
};

/**
 * Compacta un canal RTDB borrando hijos con `timestamp < cutoff`.
 * Devuelve cantidad de eventos borrados.
 *
 * Idempotente: re-ejecutar bajo el mismo cutoff produce 0 deletes adicionales.
 * Tolerante a hijos sin `timestamp` (legacy): los ignora — `endAt` filtra por
 * el indexed child, los huérfanos quedan fuera del rango y nunca se borran
 * por este cron. Eso es seguro: si se quiere limpiar legacy hace falta una
 * pasada manual.
 */
async function compactChannel(
    rtdbPath: string,
    cutoff: number,
    remainingBudget: number
): Promise<number> {
    if (remainingBudget <= 0) return 0;

    const ref = getDatabase().ref(rtdbPath);
    const snap = await ref
        .orderByChild('timestamp')
        .endAt(cutoff)
        .limitToFirst(Math.min(remainingBudget, RTDB_BATCH_SIZE * 4))
        .once('value');

    if (!snap.exists()) return 0;

    const updates: Record<string, null> = {};
    let count = 0;
    snap.forEach((child) => {
        if (count >= remainingBudget) return true;
        const key = child.key;
        if (typeof key === 'string' && key.length > 0) {
            updates[key] = null;
            count++;
        }
        return false;
    });

    if (count === 0) return 0;

    // Multi-path update para borrado atómico por lote.
    const keys = Object.keys(updates);
    for (let i = 0; i < keys.length; i += RTDB_BATCH_SIZE) {
        const slice = keys.slice(i, i + RTDB_BATCH_SIZE);
        const batch: Record<string, null> = {};
        for (const k of slice) batch[k] = null;
        await ref.update(batch);
    }
    return count;
}

export async function GET(req: NextRequest) {
    const cronSecret = env.CRON_SECRET();
    if (!cronSecret) {
        console.warn('[cron/compact-sync-events] CRON_SECRET not configured — refusing to run');
        return NextResponse.json({ error: 'Cron not configured' }, { status: 503 });
    }

    const authHeader = req.headers.get('authorization') ?? '';
    if (!safeBearerEqual(authHeader, cronSecret)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const cutoff = Date.now() - RETENTION_MS;
    let remaining = MAX_DELETES_PER_INVOCATION;
    let workspacesProcessed = 0;
    let usersProcessed = 0;
    let eventsDeleted = 0;
    const channelsHit: string[] = [];

    try {
        // (1) Workspaces compartidos → sync-events/<wsId>
        const wsSnap = await adminDb
            .collection('workspaces')
            .select()
            .limit(MAX_WORKSPACES_PER_INVOCATION)
            .get();

        for (const doc of wsSnap.docs) {
            if (remaining <= 0) break;
            const wsId = doc.id;
            if (!wsId || /[/.#$[\]]/.test(wsId)) continue;
            const path = `sync-events/${wsId}`;
            try {
                const deleted = await compactChannel(path, cutoff, remaining);
                if (deleted > 0) channelsHit.push(`${path}:${deleted}`);
                eventsDeleted += deleted;
                remaining -= deleted;
            } catch (e) {
                console.error('[cron/compact-sync-events] channel failed', path, getErrorMessage(e));
            }
            workspacesProcessed++;
        }

        // (2) Users → sync-events/personal_<uid>
        if (remaining > 0) {
            const usersSnap = await adminDb
                .collection('users')
                .select()
                .limit(MAX_USERS_PER_INVOCATION)
                .get();

            for (const doc of usersSnap.docs) {
                if (remaining <= 0) break;
                const uid = doc.id;
                if (!uid || /[/.#$[\]]/.test(uid)) continue;
                const path = `sync-events/personal_${uid}`;
                try {
                    const deleted = await compactChannel(path, cutoff, remaining);
                    if (deleted > 0) channelsHit.push(`${path}:${deleted}`);
                    eventsDeleted += deleted;
                    remaining -= deleted;
                } catch (e) {
                    console.error('[cron/compact-sync-events] channel failed', path, getErrorMessage(e));
                }
                usersProcessed++;
            }
        }

        const truncated = remaining <= 0;
        if (eventsDeleted > 0 || truncated) {
            console.info('[cron/compact-sync-events]', {
                workspacesProcessed,
                usersProcessed,
                eventsDeleted,
                truncated,
                cutoff: new Date(cutoff).toISOString(),
                channelsHit: channelsHit.slice(0, 20)
            });
        }

        return NextResponse.json({
            workspacesProcessed,
            usersProcessed,
            eventsDeleted,
            truncated,
            cutoff: new Date(cutoff).toISOString()
        });
    } catch (e) {
        console.error('[cron/compact-sync-events] error:', getErrorMessage(e));
        return NextResponse.json({
            error: getErrorMessage(e),
            workspacesProcessed,
            usersProcessed,
            eventsDeleted
        }, { status: 500 });
    }
}
