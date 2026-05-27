import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { ensureFirebaseAuthUser, findUserByEmail, normalizeEmailAddress } from '@/lib/custom-auth';
import { getErrorMessage } from '@/lib/error-utils';
import { checkAuthRateLimit, recordAuthAttempt } from '@/lib/auth-rate-limit';

const PREPARE_RESET_WINDOW_MS = 15 * 60 * 1000;
const MAX_PREPARE_RESET_ATTEMPTS = 10;

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const limitKey = `prepare-reset:${ip}`;
    const limitOptions = { windowMs: PREPARE_RESET_WINDOW_MS, maxAttempts: MAX_PREPARE_RESET_ATTEMPTS };
    const limit = await checkAuthRateLimit(limitKey, limitOptions);
    if (!limit.ok) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
      );
    }
    await recordAuthAttempt(limitKey, limitOptions);

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

    // No revelar si el email existe (anti user-enumeration): siempre 200.
    const userLookup = await findUserByEmail(rawEmail || normalizedEmail);
    if (userLookup) {
      await ensureFirebaseAuthUser({
        uid: userLookup.id,
        email: userLookup.data.email || userLookup.normalizedEmail
      });
    }

    return NextResponse.json({ status: 'ready' });
  } catch (error: unknown) {
    console.error('Error preparing password reset:', getErrorMessage(error));
    // Aun ante un fallo interno respondemos 200 para no filtrar la existencia
    // del email vía diferencias de status code.
    return NextResponse.json({ status: 'ready' });
  }
}
