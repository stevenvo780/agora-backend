import { env } from '@/lib/env';
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminDb, adminAuth } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { hashPassword } from '@/lib/crypto';
import { ensureFirebaseAuthUser, normalizeEmailAddress } from '@/lib/custom-auth';
import { getErrorMessage } from '@/lib/error-utils';
import { createLocalDevAuthToken, shouldUseLocalDevAuthFallback } from '@/lib/local-dev-auth';

// In-memory rate limiter (simple implementation)
const rateLimit = new Map<string, { count: number; expires: number }>();
const LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_ATTEMPTS = 3; // Stricter for register
const MAX_RATE_LIMIT_ENTRIES = 10_000; // prevent unbounded growth under DDoS

// Periodically evict expired entries. .unref() evita bloquear cierre del proceso.
setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of rateLimit) {
        if (now > record.expires) rateLimit.delete(ip);
    }
}, LIMIT_WINDOW).unref();

const checkRateLimit = (ip: string) => {
    const now = Date.now();
    const record = rateLimit.get(ip);
    if (record) {
        if (now > record.expires) {
            rateLimit.delete(ip);
        } else if (record.count >= MAX_ATTEMPTS) {
            return false;
        } else {
            record.count++;
            return true;
        }
    }
    // Evict oldest entry if map is too large (DDoS protection)
    if (rateLimit.size >= MAX_RATE_LIMIT_ENTRIES) {
        const firstKey = rateLimit.keys().next().value;
        if (firstKey !== undefined) rateLimit.delete(firstKey);
    }
    rateLimit.set(ip, { count: 1, expires: now + LIMIT_WINDOW });
    return true;
};

export async function POST(req: NextRequest) {
    try {
        const ip = req.headers.get('x-forwarded-for') || 'unknown';
        if (!checkRateLimit(ip)) {
            return NextResponse.json({ error: 'Too many attempts. Please try again later.' }, { status: 429 });
        }

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
        console.error('Error creating user (custom auth):', getErrorMessage(error));
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
