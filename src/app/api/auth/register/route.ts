import { env } from '@/lib/env';
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminDb, adminAuth } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { hashPassword } from '@/lib/crypto';
import { ensureFirebaseAuthUser, normalizeEmailAddress } from '@/lib/custom-auth';
import { getErrorCode, getErrorMessage } from '@/lib/error-utils';
import { createLocalDevAuthToken, shouldUseLocalDevAuthFallback } from '@/lib/local-dev-auth';
import { checkAuthRateLimit, recordAuthAttempt } from '@/lib/auth-rate-limit';

const REGISTER_WINDOW_MS = 15 * 60 * 1000;
const MAX_REGISTER_ATTEMPTS = 10;

const FIREBASE_VALIDATION_CODES = new Set([
    'auth/invalid-email',
    'auth/invalid-password',
    'auth/invalid-display-name',
    'auth/email-already-exists'
]);

const validationMessageFor = (code: string | undefined): string | null => {
    switch (code) {
        case 'auth/invalid-email':
            return 'El correo electrónico no es válido';
        case 'auth/invalid-password':
            return 'La contraseña no cumple los requisitos mínimos';
        case 'auth/email-already-exists':
            return 'Ya existe una cuenta con este correo electrónico';
        default:
            return code && FIREBASE_VALIDATION_CODES.has(code)
                ? 'Los datos proporcionados no son válidos'
                : null;
    }
};

export async function POST(req: NextRequest) {
    try {
        const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
        const limitKey = `register:${ip}`;
        const limitOptions = { windowMs: REGISTER_WINDOW_MS, maxAttempts: MAX_REGISTER_ATTEMPTS };
        const limit = await checkAuthRateLimit(limitKey, limitOptions);
        if (!limit.ok) {
            return NextResponse.json(
                { error: 'Too many attempts. Please try again later.' },
                { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
            );
        }
        await recordAuthAttempt(limitKey, limitOptions);

        let body: { email?: string; password?: string };
        try {
            body = await req.json();
        } catch {
            return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
        }
        const { email, password } = body;
        const rawEmail = typeof email === 'string' ? email.trim() : '';
        const normalizedEmail = rawEmail ? normalizeEmailAddress(rawEmail) : '';

        if (!normalizedEmail || !password) {
            return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
        }

        if (password.length < 6) {
            return NextResponse.json({ error: 'Password must be at least 6 characters' }, { status: 400 });
        }

        const usersRef = adminDb.collection('users');
        const emailIndexRef = adminDb.collection('userEmails').doc(normalizedEmail);

        const hashedPassword = await hashPassword(password);

        const newUser = {
            email: normalizedEmail,
            emailNormalized: normalizedEmail,
            passwordHash: hashedPassword,
            displayName: normalizedEmail.split('@')[0],
            createdAt: FieldValue.serverTimestamp(),
            role: 'user'
        };

        const userDocRef = usersRef.doc();
        const userId = userDocRef.id;

        try {
            await adminDb.runTransaction(async (transaction) => {
                const indexedEmailSnap = await transaction.get(emailIndexRef);
                if (indexedEmailSnap.exists) {
                    const indexedData = indexedEmailSnap.data() as { uid?: unknown } | undefined;
                    if (typeof indexedData?.uid === 'string' && indexedData.uid.trim()) {
                        const indexedUserSnap = await transaction.get(usersRef.doc(indexedData.uid));
                        if (indexedUserSnap.exists) {
                            throw new Error('USER_ALREADY_EXISTS');
                        }
                    }
                }

                const normalizedMatches = await transaction.get(usersRef.where('emailNormalized', '==', normalizedEmail).limit(1));
                if (!normalizedMatches.empty) {
                    throw new Error('USER_ALREADY_EXISTS');
                }

                if (rawEmail && rawEmail !== normalizedEmail) {
                    const rawMatches = await transaction.get(usersRef.where('email', '==', rawEmail).limit(1));
                    if (!rawMatches.empty) {
                        throw new Error('USER_ALREADY_EXISTS');
                    }
                }

                transaction.set(userDocRef, newUser);
                transaction.set(emailIndexRef, {
                    uid: userId,
                    email: normalizedEmail,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                });
            });
        } catch (error: unknown) {
            if (getErrorMessage(error) === 'USER_ALREADY_EXISTS') {
                return NextResponse.json({ error: 'User already exists' }, { status: 409 });
            }
            throw error;
        }

        // Personal workspace se gestiona en el cliente; evitamos duplicados en Firestore.

        let localDevFallback = false;
        try {
            await ensureFirebaseAuthUser({
                uid: userId,
                email: normalizedEmail,
                password
            });
        } catch (error) {
            if (!env.ALLOW_INSECURE_AUTH() && !shouldUseLocalDevAuthFallback(error)) {
                await Promise.allSettled([
                    userDocRef.delete(),
                    emailIndexRef.delete()
                ]);
                throw error;
            }
            localDevFallback = !env.ALLOW_INSECURE_AUTH();
            console.warn(
                localDevFallback
                    ? 'Firebase Admin ensureAuthUser failed (local dev signed session):'
                    : 'Firebase Admin ensureAuthUser failed (insecure mode, continuing):',
                getErrorMessage(error)
            );
        }

        let customToken: string | undefined;
        let localDevToken: string | undefined;
        try {
            customToken = await adminAuth.createCustomToken(userId, {
                userEmail: normalizedEmail
            });
        } catch (tokenError) {
            if (!env.ALLOW_INSECURE_AUTH() && !shouldUseLocalDevAuthFallback(tokenError)) {
                throw tokenError;
            }
            if (env.ALLOW_INSECURE_AUTH()) {
                console.warn('Firebase Admin createCustomToken failed (insecure mode, continuing):', getErrorMessage(tokenError));
            } else {
                console.warn('Firebase Admin createCustomToken failed (local dev signed session):', getErrorMessage(tokenError));
                localDevFallback = true;
            }
        }

        if (localDevFallback) {
            localDevToken = createLocalDevAuthToken({ uid: userId, email: normalizedEmail }) ?? undefined;
        }

        return NextResponse.json({
            uid: userId,
            email: normalizedEmail,
            displayName: normalizedEmail.split('@')[0],
            ...(customToken ? { customToken } : {}),
            ...(localDevToken ? { localDevToken } : {})
        }, { status: 201 });

    } catch (error: unknown) {
        const validationMessage = validationMessageFor(getErrorCode(error));
        if (validationMessage) {
            console.warn('Register validation error:', getErrorCode(error));
            return NextResponse.json({ error: validationMessage }, { status: 400 });
        }
        console.error('Error creating user (custom auth):', getErrorMessage(error));
        return NextResponse.json({ error: 'No se pudo crear la cuenta. Intenta de nuevo.' }, { status: 500 });
    }
}
