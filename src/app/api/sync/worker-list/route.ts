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
import { isPersonalWorkspaceId, PERSONAL_WORKSPACE_ID } from '@/types/workspace';
import { isWorkerAuthConfigured, verifyWorkerAuth } from '@/lib/worker-auth';
import { presignGet, isNasConfigured } from '@/lib/nas-storage';
import { buildRepoPath } from '@/lib/forgejo-path';
import { getErrorMessage } from '@/lib/error-utils';
import { parseDocumentRecord } from '@agora/contracts';

const SIGNED_TTL = 30 * 60; // 30 min — alcanza para descargar muchos blobs.

export async function GET(req: NextRequest) {
    try {
        if (!isNasConfigured()) return NextResponse.json({ error: 'NAS not configured' }, { status: 503 });
        const ctx = verifyWorkerAuth(req);
        if (!ctx) return NextResponse.json({ error: 'Worker auth required' }, { status: 401 });

        const { searchParams } = new URL(req.url);
        const wsParam = searchParams.get('workspaceId') ?? ctx.workspaceId;
        const since = Number.parseInt(searchParams.get('since') ?? '0', 10) || 0;

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

        const snap = await q
            .select('name', 'folder', 'type', 'storagePath', 'contentHash', 'size', 'version', 'updatedAt', 'ownerId')
            .limit(2000)
            .get();

        const items: Array<{
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
        }> = [];

        for (const d of snap.docs) {
            const parsed = parseDocumentRecord(d.id, d.data());
            if (!parsed.ok) {
                console.warn('[sync/worker-list] skipping invalid doc', d.id, parsed.error);
                continue;
            }
            const doc = parsed.value;
            if (doc.type === 'folder') continue;
            if (!doc.storagePath) continue;
            if (since > 0 && doc.updatedAtMs !== null && doc.updatedAtMs < since) continue;

            const repoPath = buildRepoPath(doc.folder, doc.name);
            let signedUrl: string | null = null;
            try {
                signedUrl = await presignGet(doc.storagePath, SIGNED_TTL);
            } catch (e) {
                console.warn('[sync/worker-list] presignGet failed for', doc.storagePath, getErrorMessage(e));
            }

            items.push({
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
            });
        }

        return NextResponse.json({
            workspaceId: wsParam,
            count: items.length,
            ts: Date.now(),
            items
        });
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
