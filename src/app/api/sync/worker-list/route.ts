/**
 * GET /api/sync/worker-list?workspaceId=<id>&since=<unix-ms?>
 *
 * Endpoint de sincronización para workers (auth HMAC, ver lib/worker-auth).
 * Devuelve metadata mínima de cada doc del workspace + signed URL para
 * descargar el blob desde MinIO directamente.
 *
 * El worker daemon en el host ejecuta esto cada ~5s, compara hashes y
 * descarga sólo los archivos cambiados.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { adminDb } from '@/lib/firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';
import { isPersonalWorkspaceId, PERSONAL_WORKSPACE_ID } from '@/types/workspace';
import { isWorkerAuthConfigured, verifyWorkerAuth } from '@/lib/worker-auth';
import { presignGet, isNasConfigured } from '@/lib/nas-storage';
import { buildRepoPath } from '@/lib/forgejo-path';
import { getErrorMessage } from '@/lib/error-utils';
import { parseDocumentRecord } from '@agora/contracts';

const SIGNED_TTL = 30 * 60; // 30 min — alcanza para descargar muchos blobs.
/**
 * Tamaño de página default si el daemon no especifica `?limit=`. NO es un
 * cap del total — el daemon itera `?cursor=<nextCursor>` hasta agotar
 * `hasMore=true`. Workspaces de 100k docs son válidos.
 */
const DEFAULT_PAGE_SIZE = 2000;
/**
 * Tamaño máximo de UNA página, no del total. Más allá de esto Firestore
 * tiende a timeout o latencia inaceptable por query individual.
 */
const MAX_PAGE_SIZE = 10_000;

interface WorkerListCursor {
  updatedAtMs: number;
  id: string;
}

const encodeWorkerListCursor = (cursor: WorkerListCursor): string =>
  Buffer.from(JSON.stringify({ u: cursor.updatedAtMs, i: cursor.id }), 'utf8').toString('base64url');

const decodeWorkerListCursor = (raw: string | null): WorkerListCursor | null => {
  if (!raw) return null;
  try {
    const buf = Buffer.from(raw, 'base64url');
    if (buf.byteLength === 0) return null;
    const parsed = JSON.parse(buf.toString('utf8')) as { u?: unknown; i?: unknown };
    if (typeof parsed.u !== 'number' || !Number.isFinite(parsed.u)) return null;
    if (typeof parsed.i !== 'string' || parsed.i.length === 0) return null;
    return { updatedAtMs: parsed.u, id: parsed.i };
  } catch {
    return null;
  }
};

export async function GET(req: NextRequest) {
    try {
        if (!isNasConfigured()) return NextResponse.json({ error: 'NAS not configured' }, { status: 503 });
        const ctx = verifyWorkerAuth(req);
        if (!ctx) return NextResponse.json({ error: 'Worker auth required' }, { status: 401 });

        const { searchParams } = new URL(req.url);
        const wsParam = searchParams.get('workspaceId') ?? ctx.workspaceId;
        const since = Number.parseInt(searchParams.get('since') ?? '0', 10) || 0;
        const presignParam = (searchParams.get('presign') ?? 'true').toLowerCase();
        const includePresign = presignParam !== 'false' && presignParam !== '0';
        const limitParam = Number.parseInt(searchParams.get('limit') ?? '', 10);
        const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Number.isFinite(limitParam) && limitParam > 0 ? limitParam : DEFAULT_PAGE_SIZE));
        const cursorParam = searchParams.get('cursor');
        const cursor = decodeWorkerListCursor(cursorParam);

        // Si el header WORKER_TOKEN difiere del query workspaceId, rechazar
        // (un worker sólo puede ver su propio workspace).
        if (wsParam !== ctx.workspaceId) {
            return NextResponse.json({ error: 'workspaceId mismatch' }, { status: 403 });
        }

        let q: FirebaseFirestore.Query = adminDb.collection('documents');
        if (isPersonalWorkspaceId(wsParam)) {
            if (!ctx.userId) {
                return NextResponse.json({ error: 'Personal workspace requires X-Worker-Uid' }, { status: 400 });
            }
            q = q.where('ownerId', '==', ctx.userId).where('workspaceId', '==', PERSONAL_WORKSPACE_ID);
        } else {
            q = q.where('workspaceId', '==', wsParam);
        }

        q = q.select('name', 'folder', 'type', 'storagePath', 'contentHash', 'size', 'version', 'updatedAt', 'ownerId')
            .orderBy('updatedAt', 'asc')
            .orderBy('__name__', 'asc');
        if (cursor) {
            q = q.startAfter(Timestamp.fromMillis(cursor.updatedAtMs), cursor.id);
        }
        const snap = await q.limit(limit).get();

        type WorkerListItem = {
            docId: string;
            name: string | null;
            folder: string | null;
            type: string | null;
            repoPath: string;
            contentHash: string | null;
            size: number | null;
            version: number | null;
            updatedAt: number | null;
            signedUrl: string | null;
        };

        const items = (
            await Promise.all(
                snap.docs.map(async (d): Promise<WorkerListItem | null> => {
                    const parsed = parseDocumentRecord(d.id, d.data());
                    if (!parsed.ok) {
                        console.warn('[sync/worker-list] skipping invalid doc', d.id, parsed.error);
                        return null;
                    }
                    const doc = parsed.value;
                    if (doc.type === 'folder') return null;
                    if (!doc.storagePath) return null;
                    if (since > 0 && doc.updatedAtMs !== null && doc.updatedAtMs < since) return null;

                    const repoPath = buildRepoPath(doc.folder, doc.name);
                    let signedUrl: string | null = null;
                    if (includePresign) {
                        try {
                            signedUrl = await presignGet(doc.storagePath, SIGNED_TTL);
                        } catch (e) {
                            console.warn('[sync/worker-list] presignGet failed for', doc.storagePath, getErrorMessage(e));
                        }
                    }

                    return {
                        docId: doc.id,
                        name: doc.name,
                        folder: doc.folder,
                        type: doc.type,
                        repoPath,
                        contentHash: doc.contentHash,
                        size: doc.size,
                        version: doc.version,
                        updatedAt: doc.updatedAtMs,
                        signedUrl
                    };
                })
            )
        ).filter((item): item is WorkerListItem => item !== null);

        let nextCursor: string | null = null;
        if (snap.size >= limit && snap.docs.length > 0) {
            const last = snap.docs[snap.docs.length - 1];
            if (last) {
                const parsedLast = parseDocumentRecord(last.id, last.data());
                if (parsedLast.ok && parsedLast.value.updatedAtMs !== null) {
                    nextCursor = encodeWorkerListCursor({
                        updatedAtMs: parsedLast.value.updatedAtMs,
                        id: last.id
                    });
                }
            }
        }

        const headers = new Headers();
        if (nextCursor) headers.set('X-Next-Cursor', nextCursor);

        return NextResponse.json({
            workspaceId: wsParam,
            count: items.length,
            ts: Date.now(),
            items,
            nextCursor,
            limit
        }, { headers });
    } catch (e) {
        console.error('[sync/worker-list] error:', getErrorMessage(e));
        return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
    }
}

// Permite probar el endpoint sin auth para health check (sin datos).
export async function HEAD() {
    return new Response(null, {
        status: 200,
        headers: {
            // Sin exponer el valor: sólo si el secret está configurado.
            'X-Worker-Secret-Set': isWorkerAuthConfigured() ? '1' : '0'
        }
    });
}
