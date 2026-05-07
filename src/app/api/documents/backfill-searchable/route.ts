/**
 * POST /api/documents/backfill-searchable?workspaceId=X
 *
 * Itera docs sin `searchableContent`, hidrata desde MinIO, computa el blob
 * denormalizado y lo guarda. Idempotente. Llamarlo desde admin/script tras
 * el deploy para cubrir docs legacy creados antes del cambio.
 *
 * Auth: requiere ADMIN_PASSWORD (X-Admin-Password header) y ENABLE_ADMIN_ENDPOINTS=true.
 *
 * Query params:
 *  - workspaceId (required)
 *  - limit (opt, default 200, max 2000) — docs por batch
 *  - dryRun (opt) — si true, no escribe Firestore.
 */
import crypto from 'node:crypto';
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminDb } from '@/lib/firebase-admin';
import { env } from '@/lib/env';
import { getErrorMessage } from '@/lib/error-utils';
import { getObjectBuffer, isNasConfigured } from '@/lib/nas-storage';
import { computeSearchableContent } from '@/lib/search/searchable-content';
import { DocumentType } from '@/types/documents';
import { isPersonalWorkspaceId } from '@/types/workspace';

const DEFAULT_BATCH = 200;
const MAX_BATCH = 2000;
const MAX_BYTES_PER_DOC = 256 * 1024;
const HYDRATE_CONCURRENCY = 8;

function timingSafeStringEqual(provided: string, expected: string): boolean {
  if (!expected) return false;
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const max = Math.max(providedBuf.length, expectedBuf.length);
  const a = Buffer.alloc(max);
  const b = Buffer.alloc(max);
  providedBuf.copy(a);
  expectedBuf.copy(b);
  const equal = crypto.timingSafeEqual(a, b);
  return equal && providedBuf.length === expectedBuf.length;
}

export async function POST(req: NextRequest) {
  try {
    if (!env.ENABLE_ADMIN_ENDPOINTS()) {
      return NextResponse.json({ error: 'Admin endpoints disabled' }, { status: 403 });
    }
    const expected = env.ADMIN_PASSWORD();
    const provided = req.headers.get('x-admin-password') ?? '';
    if (!expected || !timingSafeStringEqual(provided, expected)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!isNasConfigured()) {
      return NextResponse.json({ error: 'NAS storage not configured' }, { status: 503 });
    }

    const url = new URL(req.url);
    const workspaceId = (url.searchParams.get('workspaceId') ?? '').trim();
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId requerido' }, { status: 400 });
    }
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam
      ? Math.min(MAX_BATCH, Math.max(1, parseInt(limitParam, 10) || DEFAULT_BATCH))
      : DEFAULT_BATCH;
    const dryRun = url.searchParams.get('dryRun') === 'true';

    let queryRef: FirebaseFirestore.Query = adminDb
      .collection('documents')
      .where('workspaceId', '==', workspaceId);

    // Personal workspaces no se backfillean a ciegas — requieren scope por owner.
    if (isPersonalWorkspaceId(workspaceId)) {
      const ownerId = url.searchParams.get('ownerId') ?? '';
      if (!ownerId) {
        return NextResponse.json(
          { error: 'ownerId requerido para workspaces personales' },
          { status: 400 }
        );
      }
      queryRef = queryRef.where('ownerId', '==', ownerId);
    }

    const snapshot = await queryRef.limit(limit).get();

    type Candidate = {
      id: string;
      storagePath?: string;
      content?: string;
      type?: string;
      mimeType?: string;
      hasSearchable: boolean;
    };

    const candidates: Candidate[] = [];
    snapshot.docs.forEach(doc => {
      const data = doc.data() as Record<string, unknown>;
      const hasSearchable = typeof data.searchableContent === 'string' && data.searchableContent.length > 0;
      if (hasSearchable) return;
      const t = typeof data.type === 'string' ? data.type : '';
      if (t === DocumentType.Folder || t === DocumentType.Terminal || t === DocumentType.Files || t === DocumentType.Board || t === DocumentType.File) {
        return;
      }
      candidates.push({
        id: doc.id,
        storagePath: typeof data.storagePath === 'string' ? data.storagePath : undefined,
        content: typeof data.content === 'string' ? data.content : undefined,
        type: t,
        mimeType: typeof data.mimeType === 'string' ? data.mimeType : undefined,
        hasSearchable
      });
    });

    let updated = 0;
    let skipped = 0;
    let failed = 0;

    let cursor = 0;
    const writer = async () => {
      while (cursor < candidates.length) {
        const idx = cursor++;
        const item = candidates[idx];
        if (!item) continue;
        try {
          let raw = item.content ?? '';
          if (!raw && item.storagePath) {
            const buf = await getObjectBuffer(item.storagePath);
            if (buf) raw = buf.subarray(0, MAX_BYTES_PER_DOC).toString('utf8');
          }
          const searchable = computeSearchableContent(raw);
          if (!searchable) { skipped++; continue; }
          if (!dryRun) {
            await adminDb.collection('documents').doc(item.id).update({ searchableContent: searchable });
          }
          updated++;
        } catch (err) {
          failed++;
          console.warn('[backfill-searchable] doc', item.id, getErrorMessage(err));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(HYDRATE_CONCURRENCY, candidates.length || 1) }, writer));

    return NextResponse.json({
      workspaceId,
      scanned: snapshot.size,
      candidates: candidates.length,
      updated,
      skipped,
      failed,
      dryRun
    });
  } catch (error: unknown) {
    console.error('[backfill-searchable] error', getErrorMessage(error));
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
