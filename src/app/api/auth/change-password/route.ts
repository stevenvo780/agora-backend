import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminAuth, adminDb } from '@/lib/firebase-admin';
import { hashPassword, verifyPassword } from '@/lib/crypto';
import { ensureFirebaseAuthUser, normalizeEmailAddress } from '@/lib/custom-auth';
import { getErrorMessage } from '@/lib/error-utils';
import { requireAuth } from '@/lib/server-auth';

export async function POST(req: NextRequest) {
    try {
        const auth = await requireAuth(req);
        if (!auth) {
            return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
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
