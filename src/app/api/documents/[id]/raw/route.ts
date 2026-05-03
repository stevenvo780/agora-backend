/**
 * GET /api/documents/[id]/raw
 * Sirve el contenido del documento desde MinIO. Sin fallback Firebase Storage:
 * tras la migración stamp, todos los docs viven en MinIO.
 */
import { env } from '@/lib/env';
import { adminDb } from '@/lib/firebase-admin';
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { getErrorMessage } from '@/lib/error-utils';
import { isWorkspaceMember, requireAuth } from '@/lib/server-auth';
import { isPersonalWorkspaceId } from '@/types/workspace';
import { mockGetDoc } from '@/lib/insecure-mock-store';
import { isNasConfigured, getObjectBuffer } from '@/lib/nas-storage';

type StoredDocumentRecord = Record<string, unknown>;
const isInsecure = env.ALLOW_INSECURE_AUTH();
type RouteContext = { params: Promise<{ id: string }> };

const checkAccess = async (workspaceId: unknown, ownerId: unknown, uid: string): Promise<boolean> => {
    if (typeof workspaceId !== 'string' || isPersonalWorkspaceId(workspaceId)) {
        return ownerId === uid;
    }
    return isWorkspaceMember(workspaceId, uid);
};

export async function GET(req: NextRequest, context: RouteContext) {
    try {
        const auth = await requireAuth(req);
        if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

        const { id } = await context.params;

        if (isInsecure) {
            const doc = mockGetDoc(id);
            const content = doc?.content ?? '';
            return new Response(content, {
                headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
        }

        if (!isNasConfigured()) {
            return NextResponse.json({ error: 'NAS storage not configured' }, { status: 503 });
        }

        const docSnap = await adminDb.collection('documents').doc(id).get();
        if (!docSnap.exists) return NextResponse.json({ error: 'Document not found' }, { status: 404 });

        const data = (docSnap.data() ?? {}) as StoredDocumentRecord;
        if (!(await checkAccess(data?.workspaceId, data?.ownerId, auth.uid))) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const storagePath = typeof data.storagePath === 'string' ? data.storagePath : undefined;
        if (!storagePath) {
            // Solo docs vacíos (folders, placeholders) caen aquí. Devolver string vacío.
            const mimeType = (typeof data.mimeType === 'string' && data.mimeType) || 'text/plain';
            return new Response('', { headers: { 'Content-Type': `${mimeType}; charset=utf-8` } });
        }

        const buf = await getObjectBuffer(storagePath);
        if (!buf) return NextResponse.json({ error: 'Blob not found in NAS' }, { status: 404 });

        const mimeType = (typeof data.mimeType === 'string' && data.mimeType) || 'text/plain';
        return new Response(new Uint8Array(buf), {
            headers: { 'Content-Type': `${mimeType}; charset=utf-8` }
        });
    } catch (error: unknown) {
        console.error('Error fetching raw document:', getErrorMessage(error));
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
