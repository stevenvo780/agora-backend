import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth } from '@/lib/server-auth';
import { adminDb } from '@/lib/firebase-admin';
import { getErrorMessage } from '@/lib/error-utils';
import { Plan, SubscriptionStatus } from '@/types/subscription';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/payments/cancel
 * Marks the active subscription to not renew at period end.
 * Status stays Active; access continues until endDate.
 * The check-subscriptions cron handles the final downgrade to Free.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (!auth) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const snap = await adminDb.collection('subscriptions').doc(auth.uid).get();

    if (!snap.exists) {
      return NextResponse.json(
        { error: 'No hay una suscripción activa que cancelar' },
        { status: 400 }
      );
    }

    const data = snap.data();

    if (
      data?.status !== SubscriptionStatus.Active ||
      !data?.planId ||
      data.planId === Plan.Free
    ) {
      return NextResponse.json(
        { error: 'No hay una suscripción activa que cancelar' },
        { status: 400 }
      );
    }

    const now = new Date().toISOString();

    await adminDb.collection('subscriptions').doc(auth.uid).set(
      {
        cancelAtPeriodEnd: true,
        cancelledAt: now,
        updatedAt: now
      },
      { merge: true }
    );

    console.debug(`[Cancel] Subscription marked cancel-at-period-end for user ${auth.uid}`);

    return NextResponse.json({
      ok: true,
      status: 'active',
      endDate: data.endDate ?? null,
      cancelAtPeriodEnd: true,
      message: 'Tu plan seguirá activo hasta el fin del período y no se renovará.'
    });
  } catch (error: unknown) {
    console.error('[Cancel] Error:', getErrorMessage(error));
    return NextResponse.json(
      { error: getErrorMessage(error, 'Error al cancelar suscripción') },
      { status: 500 }
    );
  }
}
