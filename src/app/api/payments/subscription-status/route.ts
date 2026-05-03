import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth } from '@/lib/server-auth';
import { adminDb } from '@/lib/firebase-admin';
import { getErrorMessage } from '@/lib/error-utils';
import { Plan, SubscriptionStatus, type UserSubscription } from '@/types/subscription';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (!auth) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const snap = await adminDb.collection('subscriptions').doc(auth.uid).get();

    if (!snap.exists) {
      return NextResponse.json({
        subscription: {
          userId: auth.uid,
          planId: Plan.Free,
          status: SubscriptionStatus.Free,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        } as UserSubscription
      });
    }

    const data = snap.data() as UserSubscription;

    // Verificar si la suscripción ha expirado
    if (data.status === SubscriptionStatus.Active && data.endDate) {
      const endDate = new Date(data.endDate);
      if (endDate < new Date()) {
        // Suscripción expirada — actualizar ambos documentos
        const nowIso = new Date().toISOString();
        await adminDb.collection('subscriptions').doc(auth.uid).update({
          status: SubscriptionStatus.Expired,
          updatedAt: nowIso
        });
        await adminDb.collection('users').doc(auth.uid).set({
          subscription: {
            planId: Plan.Free,
            status: SubscriptionStatus.Expired
          }
        }, { merge: true });
        data.status = SubscriptionStatus.Expired;
      }
    }

    return NextResponse.json({ subscription: data });
  } catch (error: unknown) {
    console.error('Error fetching subscription:', getErrorMessage(error));
    return NextResponse.json(
      { error: getErrorMessage(error, 'Error al obtener suscripción') },
      { status: 500 }
    );
  }
}
