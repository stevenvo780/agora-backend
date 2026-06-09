import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminDb } from '@/lib/firebase-admin';
import { getErrorMessage } from '@/lib/error-utils';
import { env } from '@/lib/env';
import { listObjects, isNasConfigured } from '@/lib/nas-storage';
import { timingSafeEqual } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/cron/reconcile-storage
 *
 * Reconciliador doc↔blob: la pieza que faltaba. Firestore (metadata) y MinIO
 * (blobs) son dos fuentes de verdad sin coordinación transaccional; un
 * rename/move/delete no-atómico deja docs sin blob (huérfanos que el daemon
 * re-pulea en loop 404) o blobs sin doc. Este cron los detecta y sana:
 *
 *  - doc-sin-blob VACÍO (size 0/null) → borrar (nunca tuvo contenido).
 *  - doc-sin-blob con GEMELO (otro doc mismo contentHash con blob vivo) → borrar
 *    (el contenido sobrevive en la otra ruta).
 *  - doc-sin-blob SIN gemelo y con tamaño → CUARENTENA: se reporta, NO se borra
 *    (posible última copia; requiere revisión/recuperación manual de git/backup).
 *  - blob-sin-doc → se reporta (no se borra automáticamente).
 *
 * Ventana de gracia (graceMinutes, default 120): ignora docs editados hace poco
 * para no competir con un upload en vuelo (worker-commit escribe el doc DESPUÉS
 * del PUT, así que un doc reciente sin blob aún podría estar subiéndose).
 *
 * Protegido por CRON_SECRET. dryRun=true reporta sin borrar.
 */

const safeEqual = (value: string, expected: string): boolean => {
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

const isAuthorized = (req: NextRequest, secret: string): boolean => {
  const authHeader = req.headers.get('authorization') ?? '';
  if (authHeader && safeEqual(authHeader, `Bearer ${secret}`)) return true;
  const cronHeader = req.headers.get('x-cron-secret') ?? '';
  if (cronHeader && safeEqual(cronHeader, secret)) return true;
  return false;
};

interface DocRow {
  id: string;
  storagePath: string;
  contentHash: string | null;
  size: number;
  updatedAtMs: number;
  workspaceId: string;
}

const toMs = (v: unknown): number => {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const t = new Date(v).getTime(); return Number.isFinite(t) ? t : 0; }
  const ts = v as { toMillis?: () => number; _seconds?: number };
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts._seconds === 'number') return ts._seconds * 1000;
  return 0;
};

export async function GET(req: NextRequest) {
  const cronSecret = env.CRON_SECRET();
  if (!cronSecret) return NextResponse.json({ error: 'Cron not configured' }, { status: 503 });
  if (!isAuthorized(req, cronSecret)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isNasConfigured()) return NextResponse.json({ error: 'NAS not configured' }, { status: 503 });

  const { searchParams } = new URL(req.url);
  const dryRun = (searchParams.get('dryRun') ?? 'false').toLowerCase() === 'true';
  const graceMinutes = Math.max(0, Number.parseInt(searchParams.get('graceMinutes') ?? '120', 10) || 120);
  const graceCutoff = Date.now() - graceMinutes * 60_000;

  try {
    // Inventario completo de blobs (workspaces/ + users/).
    const blobKeys = new Set<string>();
    for (const k of await listObjects('workspaces/')) blobKeys.add(k);
    for (const k of await listObjects('users/')) blobKeys.add(k);

    // Todos los docs con blob (paginado).
    const docs: DocRow[] = [];
    const hashWithBlob = new Set<string>();
    let last: string | null = null;
    for (;;) {
      let q = adminDb.collection('documents')
        .select('storagePath', 'contentHash', 'size', 'type', 'updatedAt', 'workspaceId')
        .orderBy('__name__').limit(2000);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      if (snap.empty) break;
      for (const d of snap.docs) {
        last = d.id;
        const data = d.data() as Record<string, unknown>;
        if (data.type === 'folder' || typeof data.storagePath !== 'string' || !data.storagePath) continue;
        const sp = data.storagePath.replace(/^\//, '');
        const hash = typeof data.contentHash === 'string' ? data.contentHash : null;
        if (blobKeys.has(sp) && hash) hashWithBlob.add(hash);
        docs.push({
          id: d.id, storagePath: sp, contentHash: hash,
          size: typeof data.size === 'number' ? data.size : 0,
          updatedAtMs: toMs(data.updatedAt),
          workspaceId: typeof data.workspaceId === 'string' ? data.workspaceId : '(none)',
        });
      }
      if (snap.size < 2000) break;
    }

    const toDelete: DocRow[] = [];
    const quarantine: DocRow[] = [];
    for (const d of docs) {
      if (blobKeys.has(d.storagePath)) continue;            // tiene blob, OK
      if (d.updatedAtMs > graceCutoff) continue;            // muy reciente, gracia
      const empty = !d.size || d.size === 0;
      const hasTwin = !!(d.contentHash && hashWithBlob.has(d.contentHash));
      if (empty || hasTwin) toDelete.push(d);
      else quarantine.push(d);                               // posible última copia → no tocar
    }

    if (!dryRun && toDelete.length > 0) {
      let batch = adminDb.batch(); let n = 0;
      for (const d of toDelete) {
        batch.delete(adminDb.collection('documents').doc(d.id));
        if (++n >= 400) { await batch.commit(); batch = adminDb.batch(); n = 0; }
      }
      if (n > 0) await batch.commit();
    }

    const byWs = (rows: DocRow[]): Record<string, number> => {
      const m: Record<string, number> = {};
      for (const r of rows) m[r.workspaceId] = (m[r.workspaceId] ?? 0) + 1;
      return m;
    };

    console.warn(`[reconcile-storage] dryRun=${dryRun} docs=${docs.length} blobs=${blobKeys.size} deleted=${dryRun ? 0 : toDelete.length} quarantined=${quarantine.length}`);

    return NextResponse.json({
      dryRun,
      graceMinutes,
      totals: { docs: docs.length, blobs: blobKeys.size, orphanDocs: toDelete.length + quarantine.length },
      deleted: { count: dryRun ? 0 : toDelete.length, candidates: toDelete.length, byWorkspace: byWs(toDelete) },
      quarantined: {
        count: quarantine.length, byWorkspace: byWs(quarantine),
        sample: quarantine.slice(0, 25).map((d) => ({ id: d.id, path: d.storagePath, size: d.size, ws: d.workspaceId })),
      },
    });
  } catch (e) {
    console.error('[reconcile-storage] error:', getErrorMessage(e));
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
