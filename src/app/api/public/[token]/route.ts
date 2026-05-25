/**
 * GET /api/public/[token]
 * Sirve el contenido de un documento compartido de forma pública (sin auth).
 * Valida que el token exista y no haya expirado; devuelve el doc read-only.
 */
import { adminDb } from '@/lib/firebase-admin';
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { getErrorMessage } from '@/lib/error-utils';
import { isNasConfigured, getObjectBuffer } from '@/lib/nas-storage';
import { DocumentType } from '@/types/documents';
import type { Timestamp } from 'firebase-admin/firestore';

type RouteContext = { params: Promise<{ token: string }> };

export async function GET(_req: NextRequest, context: RouteContext) {
    try {
        const { token } = await context.params;

        const linkSnap = await adminDb.collection('sharedLinks').doc(token).get();
        if (!linkSnap.exists) {
            return NextResponse.json({ error: 'Enlace no encontrado' }, { status: 404 });
        }

        const link = linkSnap.data() ?? {};
        const expiresAt: Date | null =
            link.expiresAt instanceof Date
                ? link.expiresAt
                : link.expiresAt && typeof (link.expiresAt as Timestamp).toDate === 'function'
                  ? (link.expiresAt as Timestamp).toDate()
                  : null;

        if (!expiresAt || expiresAt < new Date()) {
            return NextResponse.json({ error: 'Enlace expirado' }, { status: 404 });
        }

        const docId = typeof link.docId === 'string' ? link.docId : null;
        if (!docId) return NextResponse.json({ error: 'Enlace inválido' }, { status: 404 });

        const docSnap = await adminDb.collection('documents').doc(docId).get();
        if (!docSnap.exists) {
            return NextResponse.json({ error: 'Documento no encontrado' }, { status: 404 });
        }

        const data = (docSnap.data() ?? {}) as Record<string, unknown>;

        const storagePath = typeof data.storagePath === 'string' ? data.storagePath : undefined;
        const isTextDoc =
            data.type === DocumentType.Text ||
            data.type === 'markdown' ||
            (!data.type && storagePath);

        if (isTextDoc && storagePath && isNasConfigured()) {
            try {
                const buf = await getObjectBuffer(storagePath);
                if (buf) data.content = buf.toString('utf8');
            } catch (err) {
                console.warn('[public/token GET] failed to fetch blob', getErrorMessage(err));
            }
        }

        const safe = {
            id: docSnap.id,
            name: data.name,
            type: data.type,
            mimeType: data.mimeType,
            content: data.content,
            folder: data.folder,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt
        };

        const res = NextResponse.json(safe);
        res.headers.set('Cache-Control', 'public, max-age=60, s-maxage=120');
        return res;
    } catch (error: unknown) {
        console.error('[public/token GET] error', error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
