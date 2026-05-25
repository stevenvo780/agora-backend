/**
 * POST /api/documents/[id]/share
 * Genera un token de enlace público read-only para el documento.
 * El token expira a los 90 días. El registro vive en Firestore
 * bajo `sharedLinks/{token}`.
 */
import { adminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { getErrorMessage } from '@/lib/error-utils';
import { requireAuth, isWorkspaceMember } from '@/lib/server-auth';
import { isPersonalWorkspaceId } from '@/types/workspace';
import { randomBytes } from 'crypto';

type RouteContext = { params: Promise<{ id: string }> };

const EXPIRY_DAYS = 90;

export async function POST(req: NextRequest, context: RouteContext) {
    try {
        const auth = await requireAuth(req);
        if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

        const { id } = await context.params;

        const docRef = adminDb.collection('documents').doc(id);
        const snap = await docRef.get();
        if (!snap.exists) return NextResponse.json({ error: 'Documento no encontrado' }, { status: 404 });

        const data = snap.data() ?? {};
        const workspaceId = typeof data.workspaceId === 'string' ? data.workspaceId : null;
        const ownerId = typeof data.ownerId === 'string' ? data.ownerId : null;

        const canAccess = isPersonalWorkspaceId(workspaceId)
            ? ownerId === auth.uid
            : workspaceId
              ? await isWorkspaceMember(workspaceId, auth.uid)
              : false;

        if (!canAccess) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

        const token = randomBytes(24).toString('base64url');
        const expiresAt = new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000);

        await adminDb.collection('sharedLinks').doc(token).set({
            docId: id,
            wsId: workspaceId,
            createdBy: auth.uid,
            expiresAt,
            createdAt: FieldValue.serverTimestamp()
        });

        return NextResponse.json({ token, expiresAt: expiresAt.toISOString() });
    } catch (error: unknown) {
        console.error('[documents/share POST] error', error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
