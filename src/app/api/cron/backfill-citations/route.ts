/**
 * POST /api/cron/backfill-citations
 *
 * Cron diario que dispara backfill del citation graph en workspaces que
 * todavía no tienen `metadata.citationsBackfilledAt` o cuyo marcador es
 * stale (>STALE_AFTER_DAYS días). Garantiza que workspaces nuevos quedan
 * indexados sin intervención manual.
 *
 * Protegido por CRON_SECRET (header `Authorization: Bearer <CRON_SECRET>`).
 * Pensado para Cloud Scheduler 1x/día.
 *
 * Body opcional:
 *  - `limit?: number`             cap de workspaces por invocación (default 20)
 *  - `staleAfterDays?: number`    recomputar si el marcador es más viejo (default 7)
 *  - `force?: boolean`            ignora marcador y reprocesa todo lo escaneado
 *
 * Respuesta: `{ scanned, processed, skipped, errors, durationMs, items }`.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { getErrorMessage } from '@/lib/error-utils';
import { env } from '@/lib/env';
import { backfillWorkspaceCitations } from '@/lib/citations/workspace-citations';
import { timingSafeEqual } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_STALE_AFTER_DAYS = 7;

const safeBearerEqual = (authHeader: string, secret: string): boolean => {
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

interface CronBody {
  limit: number;
  staleAfterDays: number;
  force: boolean;
}

export const parseCronBody = (raw: unknown): CronBody => {
  const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};

  const limitRaw = typeof obj.limit === 'number' ? obj.limit : DEFAULT_LIMIT;
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT)));

  const staleRaw = typeof obj.staleAfterDays === 'number' ? obj.staleAfterDays : DEFAULT_STALE_AFTER_DAYS;
  const staleAfterDays = Math.max(0, Math.floor(Number.isFinite(staleRaw) ? staleRaw : DEFAULT_STALE_AFTER_DAYS));

  const force = obj.force === true;
  return { limit, staleAfterDays, force };
};

interface WorkspaceCandidate {
  id: string;
  citationsBackfilledAt: number | null;
}

const toMillis = (value: unknown): number | null => {
  if (!value) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'object') {
    const obj = value as { toMillis?: () => number; _seconds?: number; seconds?: number };
    if (typeof obj.toMillis === 'function') {
      try { return obj.toMillis(); } catch { /* fallthrough */ }
    }
    const secs = typeof obj._seconds === 'number' ? obj._seconds : (typeof obj.seconds === 'number' ? obj.seconds : null);
    if (secs !== null) return secs * 1000;
  }
  return null;
};

const pickCandidates = async (limit: number, staleAfterDays: number, force: boolean): Promise<WorkspaceCandidate[]> => {
  // Cap el barrido: workspaces es pequeño (~docenas) pero evitamos full-scan
  // sin techo si crece. Page = 5x el limit para tener margen tras filtrar.
  const scanCap = Math.max(limit * 5, 50);
  const snap = await adminDb.collection('workspaces').limit(scanCap).get();

  const cutoff = staleAfterDays > 0 ? Date.now() - (staleAfterDays * 24 * 60 * 60 * 1000) : Date.now();
  const out: WorkspaceCandidate[] = [];

  for (const doc of snap.docs) {
    if (out.length >= limit) break;
    const data = doc.data() as Record<string, unknown>;
    const metadata = (data.metadata && typeof data.metadata === 'object') ? data.metadata as Record<string, unknown> : {};
    const marker = toMillis(metadata.citationsBackfilledAt);
    const isStale = marker === null || marker < cutoff;
    if (force || isStale) {
      out.push({ id: doc.id, citationsBackfilledAt: marker });
    }
  }
  return out;
};

interface ProcessedItem {
  workspaceId: string;
  docsProcessed: number;
  edgesWritten: number;
  durationMs: number;
  error?: string;
}

export async function POST(req: NextRequest) {
  const cronSecret = env.CRON_SECRET();
  if (!cronSecret) {
    console.warn('[cron/backfill-citations] CRON_SECRET no configurado — refusing to run');
    return NextResponse.json({ error: 'Cron not configured' }, { status: 503 });
  }

  const authHeader = req.headers.get('authorization') ?? '';
  if (!safeBearerEqual(authHeader, cronSecret)) {
    console.warn('[cron/backfill-citations] Unauthorized cron attempt');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let rawBody: unknown = {};
  try {
    rawBody = await req.json();
  } catch {
    // Body opcional — Cloud Scheduler puede mandar vacío.
    rawBody = {};
  }
  const { limit, staleAfterDays, force } = parseCronBody(rawBody);

  const startedAt = Date.now();
  let candidates: WorkspaceCandidate[];
  try {
    candidates = await pickCandidates(limit, staleAfterDays, force);
  } catch (err) {
    console.error('[cron/backfill-citations] error listando workspaces:', getErrorMessage(err));
    return NextResponse.json({ error: getErrorMessage(err) }, { status: 500 });
  }

  const items: ProcessedItem[] = [];
  let processed = 0;
  let skipped = 0;
  let errorCount = 0;

  for (const candidate of candidates) {
    try {
      const result = await backfillWorkspaceCitations(candidate.id);
      items.push({
        workspaceId: candidate.id,
        docsProcessed: result.docsProcessed,
        edgesWritten: result.edgesWritten,
        durationMs: result.durationMs
      });
      // Marcar incluso si docsProcessed === 0 — significa que el workspace
      // no tiene contenido aún y no queremos re-procesarlo mañana. Si el user
      // sube docs, el flujo normal (parseAndPersistCitationsForDoc) los indexa.
      await adminDb.collection('workspaces').doc(candidate.id).set({
        metadata: { citationsBackfilledAt: FieldValue.serverTimestamp() }
      }, { merge: true });
      processed += 1;
    } catch (err) {
      const message = getErrorMessage(err);
      items.push({
        workspaceId: candidate.id,
        docsProcessed: 0,
        edgesWritten: 0,
        durationMs: 0,
        error: message
      });
      errorCount += 1;
      console.error(`[cron/backfill-citations] workspace ${candidate.id} falló:`, message);
    }
  }

  skipped = 0; // ya filtrado en pickCandidates; reservado para futura paginación
  const durationMs = Date.now() - startedAt;
  console.info('[cron/backfill-citations]', {
    scanned: candidates.length,
    processed,
    errors: errorCount,
    durationMs,
    limit,
    staleAfterDays,
    force
  });

  return NextResponse.json({
    scanned: candidates.length,
    processed,
    skipped,
    errors: errorCount,
    durationMs,
    items
  });
}
