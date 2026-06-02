import { env } from '@/lib/env';
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminAuth } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { verifyPassword } from '@/lib/crypto';
import { ensureFirebaseAuthUser, findUserByEmail, normalizeEmailAddress } from '@/lib/custom-auth';
import { getErrorMessage } from '@/lib/error-utils';
import { createLocalDevAuthToken, shouldUseLocalDevAuthFallback } from '@/lib/local-dev-auth';
import { syncWorkspaceClaims } from '@/lib/workspace-claims';
import { checkAuthRateLimit, recordAuthAttempt } from '@/lib/auth-rate-limit';
import { getClientIp } from '@/lib/http/client-ip';

const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_LOGIN_ATTEMPTS = 10;

const tooManyAttempts = (retryAfterSeconds: number) =>
    NextResponse.json(
        { error: 'Demasiados intentos. Intentá de nuevo más tarde.' },
        { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } }
    );

export async function POST(req: NextRequest) {
    try {
        const ip = getClientIp(req);

        let body: { email?: string; password?: string };
        try {
            body = await req.json();
        } catch {
            return NextResponse.json({ error: 'Cuerpo JSON inválido' }, { status: 400 });
        }
        const { email, password } = body;
        const rawEmail = typeof email === 'string' ? email.trim() : '';
        const normalizedEmail = rawEmail ? normalizeEmailAddress(rawEmail) : '';

        if (!normalizedEmail || !password) {
            return NextResponse.json({ error: 'Email y contraseña son requeridos' }, { status: 400 });
        }

        const limitKey = `login:${ip}:${normalizedEmail}`;
        const emailLimitKey = `login:email:${normalizedEmail}`;
        const limitOptions = { windowMs: FAILED_LOGIN_WINDOW_MS, maxAttempts: MAX_FAILED_LOGIN_ATTEMPTS };
        const [limit, emailLimit] = await Promise.all([
            checkAuthRateLimit(limitKey, limitOptions),
            checkAuthRateLimit(emailLimitKey, limitOptions),
        ]);
        if (!limit.ok) {
            return tooManyAttempts(limit.retryAfterSeconds);
        }
        if (!emailLimit.ok) {
            return tooManyAttempts(emailLimit.retryAfterSeconds);
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
            await Promise.all([
                recordAuthAttempt(limitKey, limitOptions),
                recordAuthAttempt(emailLimitKey, limitOptions),
            ]);
            return NextResponse.json({ error: 'Credenciales inválidas' }, { status: 401 });
        }

        const userLookup = await findUserByEmail(rawEmail || normalizedEmail);
        if (!userLookup) {
            await Promise.all([
                recordAuthAttempt(limitKey, limitOptions),
                recordAuthAttempt(emailLimitKey, limitOptions),
            ]);
            return NextResponse.json({ error: 'Credenciales inválidas' }, { status: 401 });
        }

        const userDocRef = userLookup.ref;
        const userData = userLookup.data;

        const verification = await verifyPassword(password, userData?.passwordHash);

        if (!verification.ok) {
            await Promise.all([
                recordAuthAttempt(limitKey, limitOptions),
                recordAuthAttempt(emailLimitKey, limitOptions),
            ]);
            return NextResponse.json({ error: 'Credenciales inválidas' }, { status: 401 });
        }

        if (verification.needsUpgrade && verification.newHash) {
            await userDocRef.update({
                passwordHash: verification.newHash,
                updatedAt: FieldValue.serverTimestamp()
            });
        }

        let customToken: string | undefined;
        let localDevToken: string | undefined;
        try {
            await ensureFirebaseAuthUser({
                uid: userLookup.id,
                email: userData.email || userLookup.normalizedEmail,
                password
            });

            customToken = await adminAuth.createCustomToken(userLookup.id, {
                userEmail: userData.email || userLookup.normalizedEmail
            });
            // Sync workspace membership into custom claims (non-blocking)
            syncWorkspaceClaims(userLookup.id).catch(() => {});
        } catch (tokenError: unknown) {
            if (env.ALLOW_INSECURE_AUTH()) {
                console.warn('Firebase Admin token creation failed (insecure mode, continuing):', getErrorMessage(tokenError));
            } else if (shouldUseLocalDevAuthFallback(tokenError)) {
                console.warn('Firebase Admin token creation failed (local dev signed session):', getErrorMessage(tokenError));
                localDevToken = createLocalDevAuthToken({
                    uid: userLookup.id,
                    email: userData.email || userLookup.normalizedEmail
                }) ?? undefined;
            } else {
                throw tokenError;
            }
        }

        return NextResponse.json({
            uid: userLookup.id,
            email: userData.email || normalizedEmail,
            displayName: userData.displayName || 'User',
            photoURL: userData.photoURL || null,
            ...(customToken ? { customToken } : {}),
            ...(localDevToken ? { localDevToken } : {})
        }, { status: 200 });

    } catch (error: unknown) {
        console.error('Error login (custom auth):', getErrorMessage(error));
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
