import { NextRequest, NextResponse } from '@/lib/http/next-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { adminDb } from '@/lib/firebase-admin';
import { isPersonalWorkspaceId, PERSONAL_WORKSPACE_ID } from '@/types/workspace';
import { verifyWorkerAuth } from '@/lib/worker-auth';
import { presignGet, isNasConfigured } from '@/lib/nas-storage';
import { getErrorMessage } from '@/lib/error-utils';
import { parseDocumentRecord } from '@agora/contracts';

const SIGNED_TTL = 30 * 60;
const MAX_BATCH = 100;
const PRESIGN_CONCURRENCY = 12;

interface FetchRequestItem {
  docId: string;
  contentHash?: string | null;
}

interface FetchResponseItem {
  docId: string;
  contentHash: string | null;
  storagePath: string | null;
  size: number | null;
  signedUrl: string | null;
  unchanged: boolean;
  error?: string;
}

const parseBody = (raw: unknown): { items: FetchRequestItem[] } | null => {
  if (!raw || typeof raw !== 'object') return null;
  const itemsRaw = (raw as { items?: unknown }).items;
  if (!Array.isArray(itemsRaw)) return null;
  const items: FetchRequestItem[] = [];
  for (const entry of itemsRaw.slice(0, MAX_BATCH)) {
    if (!entry || typeof entry !== 'object') continue;
    const docId = (entry as { docId?: unknown }).docId;
    if (typeof docId !== 'string' || !docId.trim()) continue;
    const contentHash = (entry as { contentHash?: unknown }).contentHash;
    items.push({
      docId: docId.trim(),
      contentHash: typeof contentHash === 'string' ? contentHash : null
    });
  }
  return { items };
};

const runConcurrent = async <T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> => {
  const results: T[] = new Array(tasks.length);
  let cursor = 0;
  const limit = Math.max(1, Math.min(concurrency, tasks.length));
  const workers: Promise<void>[] = [];
  for (let i = 0; i < limit; i += 1) {
    workers.push((async () => {
      for (;;) {
        const idx = cursor;
        cursor += 1;
        if (idx >= tasks.length) return;
        const task = tasks[idx];
        if (!task) return;
        results[idx] = await task();
      }
    })());
  }
  await Promise.all(workers);
  return results;
};

export async function POST(req: NextRequest) {
  try {
    if (!isNasConfigured()) return NextResponse.json({ error: 'NAS not configured' }, { status: 503 });
    const ctx = verifyWorkerAuth(req);
    if (!ctx) return NextResponse.json({ error: 'Worker auth required' }, { status: 401 });

    const raw = await req.json().catch(() => null);
    const parsed = parseBody(raw);
    if (!parsed || parsed.items.length === 0) {
      return NextResponse.json({ error: 'items required (max 100)' }, { status: 400 });
    }

    if (isPersonalWorkspaceId(ctx.workspaceId) && !ctx.userId) {
      return NextResponse.json({ error: 'Personal workspace requires X-Worker-Uid' }, { status: 400 });
    }

    const tasks = parsed.items.map(item => async (): Promise<FetchResponseItem> => {
      try {
        const snap = await adminDb.collection('documents').doc(item.docId).get();
        if (!snap.exists) {
          return { docId: item.docId, contentHash: null, storagePath: null, size: null, signedUrl: null, unchanged: false, error: 'not-found' };
        }
        const docParsed = parseDocumentRecord(snap.id, snap.data());
        if (!docParsed.ok) {
          return { docId: item.docId, contentHash: null, storagePath: null, size: null, signedUrl: null, unchanged: false, error: 'invalid-record' };
        }
        const doc = docParsed.value;

        const isPersonal = isPersonalWorkspaceId(ctx.workspaceId);
        const docOwnerWs = doc.workspaceId ?? null;
        if (isPersonal) {
          if (docOwnerWs !== PERSONAL_WORKSPACE_ID) {
            return { docId: item.docId, contentHash: doc.contentHash, storagePath: doc.storagePath, size: doc.size, signedUrl: null, unchanged: false, error: 'forbidden' };
          }
          if (doc.ownerId !== ctx.userId) {
            return { docId: item.docId, contentHash: doc.contentHash, storagePath: doc.storagePath, size: doc.size, signedUrl: null, unchanged: false, error: 'forbidden' };
          }
        } else if (docOwnerWs !== ctx.workspaceId) {
          return { docId: item.docId, contentHash: doc.contentHash, storagePath: doc.storagePath, size: doc.size, signedUrl: null, unchanged: false, error: 'forbidden' };
        }

        if (!doc.storagePath) {
          return { docId: item.docId, contentHash: doc.contentHash, storagePath: null, size: doc.size, signedUrl: null, unchanged: false, error: 'no-storage-path' };
        }

        if (item.contentHash && doc.contentHash && item.contentHash === doc.contentHash) {
          return { docId: item.docId, contentHash: doc.contentHash, storagePath: doc.storagePath, size: doc.size, signedUrl: null, unchanged: true };
        }

        let signedUrl: string | null = null;
        try {
          signedUrl = await presignGet(doc.storagePath, SIGNED_TTL);
        } catch (err) {
          return { docId: item.docId, contentHash: doc.contentHash, storagePath: doc.storagePath, size: doc.size, signedUrl: null, unchanged: false, error: getErrorMessage(err) };
        }

        return { docId: item.docId, contentHash: doc.contentHash, storagePath: doc.storagePath, size: doc.size, signedUrl, unchanged: false };
      } catch (err) {
        return { docId: item.docId, contentHash: null, storagePath: null, size: null, signedUrl: null, unchanged: false, error: getErrorMessage(err) };
      }
    });

    const items = await runConcurrent(tasks, PRESIGN_CONCURRENCY);
    return NextResponse.json({
      workspaceId: ctx.workspaceId,
      ts: Date.now(),
      count: items.length,
      items
    });
  } catch (e) {
    console.error('[sync/worker-fetch] error:', getErrorMessage(e));
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
