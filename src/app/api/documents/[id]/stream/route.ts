import { env } from '@/lib/env';
import { adminDb } from '@/lib/firebase-admin';
import type { DocumentSnapshot } from 'firebase-admin/firestore';
import { NextRequest } from '@/lib/http/next-server';
import { isWorkspaceMember, requireAuth } from '@/lib/server-auth';
import { DocumentType } from '@/types/documents';
import { PERSONAL_WORKSPACE_ID, isPersonalWorkspaceId } from '@/types/workspace';
import { getErrorMessage } from '@/lib/error-utils';
import { isNasConfigured, presignGet } from '@/lib/nas-storage';

// In-memory throttle so we don't re-sign on every onSnapshot tick.
const streamUrlThrottle = new Map<string, { url: string; ts: number }>();
const STREAM_URL_TTL_MS = 45 * 60 * 1000;
const STREAM_URL_MAX_ENTRIES = 500;

const evictStaleStreamUrls = () => {
    const now = Date.now();
    for (const [k, v] of streamUrlThrottle) {
        if (now - v.ts > STREAM_URL_TTL_MS) streamUrlThrottle.delete(k);
    }
    // Si después del barrido sigue sobre el límite, descartar las más viejas.
    if (streamUrlThrottle.size > STREAM_URL_MAX_ENTRIES) {
        const sorted = [...streamUrlThrottle.entries()].sort((a, b) => a[1].ts - b[1].ts);
        const drop = sorted.slice(0, streamUrlThrottle.size - STREAM_URL_MAX_ENTRIES);
        for (const [k] of drop) streamUrlThrottle.delete(k);
    }
};

async function maybeFreshUrl(docId: string, data: Record<string, unknown>): Promise<string | null> {
    if (data.type !== DocumentType.File || typeof data.storagePath !== 'string') return null;
    const cached = streamUrlThrottle.get(docId);
    if (cached && Date.now() - cached.ts < STREAM_URL_TTL_MS) return cached.url;
    if (!isNasConfigured()) return null;
    try {
        const url = await presignGet(data.storagePath as string, 60 * 60);
        streamUrlThrottle.set(docId, { url, ts: Date.now() });
        if (streamUrlThrottle.size > STREAM_URL_MAX_ENTRIES) evictStaleStreamUrls();
        return url;
    } catch (error) {
        console.warn('stream: failed to refresh signed URL', getErrorMessage(error));
        return null;
    }
}

export const runtime = 'nodejs';
type RouteContext = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, context: RouteContext) {
    const auth = await requireAuth(req);
    if (!auth) {
        return new Response('No autorizado', { status: 401 });
    }

    const { id } = await context.params;

    if (env.ALLOW_INSECURE_AUTH()) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                const send = (payload: unknown) => {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
                };

                const keepAlive = setInterval(() => {
                    controller.enqueue(encoder.encode(': keep-alive\n\n'));
                }, 15000);

                send({
                    type: 'snapshot',
                    data: {
                        id,
                        name: 'Documento de Prueba.md',
                        type: DocumentType.Text,
                        workspaceId: PERSONAL_WORKSPACE_ID,
                        folder: '',
                        updatedAt: { seconds: Date.now() / 1000 },
                        createdAt: { seconds: Date.now() / 1000 },
                        ownerId: auth.uid
                    }
                });

                req.signal.addEventListener('abort', () => {
                    clearInterval(keepAlive);
                    controller.close();
                });
            }
        });

        return new Response(stream, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive'
            }
        });
    }

    const encoder = new TextEncoder();

    const docSnap = await adminDb.collection('documents').doc(id).get();
    if (!docSnap.exists) {
        return new Response('Document not found', { status: 404 });
    }
    const data = docSnap.data() as Record<string, unknown>;
    const workspaceId = typeof data?.workspaceId === 'string' ? data.workspaceId : null;
    if (isPersonalWorkspaceId(workspaceId)) {
        if (data?.ownerId !== auth.uid) {
            return new Response('Forbidden', { status: 403 });
        }
    } else {
        if (!workspaceId) {
            return new Response('Forbidden', { status: 403 });
        }
        const member = await isWorkspaceMember(workspaceId, auth.uid);
        if (!member) {
            return new Response('Forbidden', { status: 403 });
        }
    }

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const send = (payload: unknown) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
            };

            const keepAlive = setInterval(() => {
                controller.enqueue(encoder.encode(': keep-alive\n\n'));
            }, 15000);

            send({ type: 'connected' });

            // Throttle snapshot emissions to reduce billed reads during rapid editing.
            // onSnapshot fires on every write; we coalesce events within a 2s window.
            const SNAPSHOT_THROTTLE_MS = 2000;
            let pendingSnap: DocumentSnapshot | null = null;
            let throttleTimer: ReturnType<typeof setTimeout> | null = null;

            const flushSnapshot = async () => {
                throttleTimer = null;
                const snap = pendingSnap;
                pendingSnap = null;
                if (!snap) return;
                if (!snap.exists) {
                    send({ type: 'deleted' });
                    return;
                }
                const snapData = { id: snap.id, ...snap.data() } as Record<string, unknown>;
                const freshUrl = await maybeFreshUrl(id, snapData);
                if (freshUrl) snapData.url = freshUrl;
                send({ type: 'snapshot', data: snapData });
            };

            const docRef = adminDb.collection('documents').doc(id);
            let isFirst = true;
            const unsubscribe = docRef.onSnapshot((snap) => {
                // Always send the first snapshot immediately so the client loads fast
                if (isFirst) {
                    isFirst = false;
                    pendingSnap = snap;
                    void flushSnapshot();
                    return;
                }
                pendingSnap = snap;
                if (!throttleTimer) {
                    throttleTimer = setTimeout(flushSnapshot, SNAPSHOT_THROTTLE_MS);
                }
            }, (error) => {
                send({ type: 'error', error: error.message });
            });

            const close = () => {
                clearInterval(keepAlive);
                if (throttleTimer) clearTimeout(throttleTimer);
                unsubscribe();
                controller.close();
            };

            req.signal.addEventListener('abort', close);
        }
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive'
        }
    });
}
