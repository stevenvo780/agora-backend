import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminAuth, adminDb } from '@/lib/firebase-admin';
import { hashPassword, verifyPassword } from '@/lib/crypto';
import { ensureFirebaseAuthUser, normalizeEmailAddress } from '@/lib/custom-auth';
import { getErrorMessage } from '@/lib/error-utils';
import { requireAuth } from '@/lib/server-auth';
import { checkAuthRateLimit, recordAuthAttempt } from '@/lib/auth-rate-limit';

const CHANGE_PASSWORD_WINDOW_MS = 15 * 60 * 1000;
const MAX_CHANGE_PASSWORD_ATTEMPTS = 5;

export async function POST(req: NextRequest) {
    try {
        const auth = await requireAuth(req);
        if (!auth) {
            return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
        }

        const limitKey = `change-password:${auth.uid}`;
        const limitOptions = { windowMs: CHANGE_PASSWORD_WINDOW_MS, maxAttempts: MAX_CHANGE_PASSWORD_ATTEMPTS };
        const limit = await checkAuthRateLimit(limitKey, limitOptions);
        if (!limit.ok) {
            return NextResponse.json(
                { error: 'Demasiados intentos. Intentá de nuevo más tarde.' },
                { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
            );
        }

        let body: { currentPassword?: string; newPassword?: string };
        try {
            body = await req.json();
        } catch {
            return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
        }
        const { currentPassword, newPassword } = body;

        if (!currentPassword || !newPassword) {
            return NextResponse.json(
                { error: 'Se requieren todos los campos' },
                { status: 400 }
            );
        }

        if (newPassword.length < 6) {
            return NextResponse.json(
                { error: 'La nueva contraseña debe tener al menos 6 caracteres' },
                { status: 400 }
            );
        }

        const userDoc = await adminDb.collection('users').doc(auth.uid).get();

        if (!userDoc.exists) {
            return NextResponse.json(
                { error: 'Usuario no encontrado' },
                { status: 404 }
            );
        }

        const userData = userDoc.data();
        const normalizedEmail = typeof userData?.email === 'string'
            ? normalizeEmailAddress(userData.email)
            : null;

        const verification = await verifyPassword(currentPassword, userData?.passwordHash);
        if (!verification.ok) {
            await recordAuthAttempt(limitKey, limitOptions);
            return NextResponse.json(
                { error: 'Contraseña actual incorrecta' },
                { status: 401 }
            );
        }

        const newPasswordHash = await hashPassword(newPassword);

        await adminDb.collection('users').doc(auth.uid).update({
            passwordHash: newPasswordHash,
            updatedAt: new Date(),
            ...(normalizedEmail ? { emailNormalized: normalizedEmail } : {})
        });

        if (normalizedEmail) {
            await ensureFirebaseAuthUser({
                uid: auth.uid,
                email: normalizedEmail,
                password: newPassword
            });
        } else {
            await adminAuth.updateUser(auth.uid, { password: newPassword }).catch(() => {});
        }

        return NextResponse.json({ success: true, message: 'Contraseña actualizada correctamente' });
    } catch (error: unknown) {
        console.error('Error changing password:', getErrorMessage(error));
        return NextResponse.json(
            { error: getErrorMessage(error, 'Error al cambiar la contraseña') },
            { status: 500 }
        );
    }
}
