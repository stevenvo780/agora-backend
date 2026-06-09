import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminDb } from '@/lib/firebase-admin';
import { requireAuth } from '@/lib/server-auth';
import { getErrorMessage } from '@/lib/error-utils';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const COLLECTION = 'cliTokens';

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

    const { id } = await params;
    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: 'id requerido' }, { status: 400 });
    }

    const docRef = adminDb.collection(COLLECTION).doc(id);
    const snap = await docRef.get();

    if (!snap.exists) {
      return NextResponse.json({ error: 'Token no encontrado' }, { status: 404 });
    }

    const data = snap.data();
    if (data?.['uid'] !== auth.uid) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 403 });
    }

    await docRef.update({ revoked: true });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: getErrorMessage(err) }, { status: 500 });
  }
}
