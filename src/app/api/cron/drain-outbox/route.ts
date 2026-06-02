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
import { parseOutboxRecord, type OutboxRecord } from '@agora/contracts';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_DRAIN = 200;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_RETRIES = 5;

// El write a RTDB de firebase-admin no rechaza por sí solo si la conexión no
// llega a ack-ear (el SDK bufferea sobre un WebSocket persistente). Sin un
// timeout explícito el handler queda colgado hasta que la plataforma mate el
// request (~25s observado en el lab), dejando el doc sin marcar y el conteo sin
// significado. Acotamos cada publish: si no ack-ea a tiempo cuenta como `failed`.
const PUBLISH_TIMEOUT_MS = 8000;

export interface DrainDeps {
  /** Publica el payload a RTDB. Debe rechazar (no colgar) si no se puede. */
  publish: (rtdbPath: string, payload: Record<string, unknown>) => Promise<void>;
  /** Marca el doc como publicado (idempotencia: no se reprocesa). */
  markPublished: (id: string) => Promise<void>;
  /** Registra el fallo y sube retryCount para backoff/expiración. */
  markFailed: (id: string, retryCount: number, error: string) => Promise<void>;
  /** Saca de la cola un doc corrupto/viejo/sin reintentos. */
  expire: (id: string) => Promise<void>;
}

export interface DrainResult {
  drained: number;
  failed: number;
  expired: number;
  total: number;
}

interface DrainCandidate {
  id: string;
  parsed: ReturnType<typeof parseOutboxRecord>;
}

/**
 * Núcleo puro del drainer: itera candidatos y delega los efectos en `deps`.
 * `drained` cuenta SOLO eventos cuyo write a RTDB ack-eó Y cuyo doc quedó
 * marcado. Si el publish falla (incluido timeout) el evento NO cuenta como
 * drenado: sube `failed`, se loguea y se reintenta en la próxima corrida.
 */
export async function drainOutboxDocs(
  candidates: DrainCandidate[],
  deps: DrainDeps,
  nowMs: number
): Promise<DrainResult> {
  const cutoff = nowMs - MAX_AGE_MS;
  let drained = 0;
  let failed = 0;
  let expired = 0;

  for (const { id, parsed } of candidates) {
    if (!parsed.ok) {
      // Doc corrupto: nunca se podrá publicar y, si solo lo marcáramos,
      // seguiría cayendo en `published == false` para siempre.
      await deps.expire(id);
      expired++;
      continue;
    }
    const rec: OutboxRecord = parsed.value;

    if (rec.ts < cutoff || rec.retryCount >= MAX_RETRIES) {
      // Demasiado viejo o sin reintentos: el ping ya no tiene valor de replay.
      await deps.expire(id);
      expired++;
      continue;
    }

    try {
      await deps.publish(rec.rtdbPath, rec.payload);
    } catch (e) {
      failed++;
      console.error('[cron/drain-outbox] publish failed', id, getErrorMessage(e));
      await deps.markFailed(id, rec.retryCount + 1, getErrorMessage(e).slice(0, 200));
      continue;
    }

    try {
      await deps.markPublished(id);
    } catch (e) {
      // El evento SÍ llegó a RTDB pero no pudimos marcar el doc. No lo contamos
      // como drenado: la próxima corrida reintentará (RTDB tolera el push extra
      // mejor que un silent-loss). Lo registramos para no esconder el problema.
      failed++;
      console.error('[cron/drain-outbox] markPublished failed', id, getErrorMessage(e));
      continue;
    }

    drained++;
  }

  return { drained, failed, expired, total: candidates.length };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? '';
  const cronSecret = env.CRON_SECRET();
  const ok = Boolean(cronSecret && authHeader === `Bearer ${cronSecret}`);
  if (!ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const snap = await adminDb
      .collection('syncEventsOutbox')
      .where('published', '==', false)
      .limit(MAX_DRAIN)
      .get();

    const candidates: DrainCandidate[] = snap.docs.map((d) => ({
      id: d.id,
      parsed: parseOutboxRecord(d.id, d.data())
    }));

    const refById = new Map(snap.docs.map((d) => [d.id, d.ref] as const));
    const deps: DrainDeps = {
      publish: (rtdbPath, payload) =>
        withTimeout(getDatabase().ref(rtdbPath).push().set(payload), PUBLISH_TIMEOUT_MS, 'rtdb publish'),
      markPublished: async (id) => {
        await refById.get(id)?.update({
          published: true,
          publishedAt: FieldValue.serverTimestamp()
        });
      },
      markFailed: async (id, retryCount, error) => {
        await refById.get(id)?.update({
          retryCount,
          lastRetryAt: FieldValue.serverTimestamp(),
          lastError: error
        });
      },
      expire: async (id) => {
        await refById.get(id)?.delete();
      }
    };

    const result = await drainOutboxDocs(candidates, deps, Date.now());

    if (result.drained || result.failed || result.expired) {
      console.info('[cron/drain-outbox]', result);
    }
    return NextResponse.json(result);
  } catch (e) {
    console.error('[cron/drain-outbox] error:', getErrorMessage(e));
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
