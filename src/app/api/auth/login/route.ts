import { env } from '@/lib/env';
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminAuth } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { verifyPassword } from '@/lib/crypto';
import { ensureFirebaseAuthUser, findUserByEmail, normalizeEmailAddress } from '@/lib/custom-auth';
import { getErrorMessage } from '@/lib/error-utils';
import { createLocalDevAuthToken, shouldUseLocalDevAuthFallback } from '@/lib/local-dev-auth';
import { syncWorkspaceClaims } from '@/lib/workspace-claims';

// In-memory rate limiter
const rateLimit = new Map<string, { count: number; expires: number }>();
const LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_ATTEMPTS = 5;
const MAX_RATE_LIMIT_ENTRIES = 10_000; // prevent unbounded growth under DDoS

// Periodically evict expired entries to prevent unbounded Map growth.
// .unref() evita que el interval bloquee el cierre del proceso Node.js.
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
    // Evict oldest entries if the map is too large (DDoS protection)
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

        const { email, password } = await req.json();
        const rawEmail = typeof email === 'string' ? email.trim() : '';
        const normalizedEmail = rawEmail ? normalizeEmailAddress(rawEmail) : '';

        if (!normalizedEmail || !password) {
            return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
        }

        const userLookup = await findUserByEmail(rawEmail || normalizedEmail);
        if (!userLookup) {
            return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
        }

        const userDocRef = userLookup.ref;
        const userData = userLookup.data;

        const verification = await verifyPassword(password, userData?.passwordHash);

        if (!verification.ok) {
             return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
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
