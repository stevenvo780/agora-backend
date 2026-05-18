import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { ensureFirebaseAuthUser, findUserByEmail, normalizeEmailAddress } from '@/lib/custom-auth';
import { getErrorMessage } from '@/lib/error-utils';

export async function POST(req: NextRequest) {
  try {
    let body: { email?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const rawEmail = typeof body?.email === 'string' ? body.email.trim() : '';
    const normalizedEmail = rawEmail ? normalizeEmailAddress(rawEmail) : '';

    if (!normalizedEmail) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 });
    }

    const userLookup = await findUserByEmail(rawEmail || normalizedEmail);
    if (!userLookup) {
      return NextResponse.json({ error: 'No existe una cuenta con este correo electrónico' }, { status: 404 });
    }

    await ensureFirebaseAuthUser({
      uid: userLookup.id,
      email: userLookup.data.email || userLookup.normalizedEmail
    });

    return NextResponse.json({ status: 'ready' });
  } catch (error: unknown) {
    console.error('Error preparing password reset:', getErrorMessage(error));
    return NextResponse.json(
      { error: getErrorMessage(error, 'Error al preparar la recuperación de contraseña') },
      { status: 500 }
    );
  }
}
