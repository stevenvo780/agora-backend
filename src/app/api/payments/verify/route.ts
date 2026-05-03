import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { MercadoPagoConfig, Payment } from 'mercadopago';
import { requireAuth } from '@/lib/server-auth';
import { adminDb } from '@/lib/firebase-admin';
import { getErrorMessage } from '@/lib/error-utils';
import { SubscriptionStatus, type PlanId } from '@/types/subscription';
import { calculateSmartEndDate } from '@/app/api/payments/helpers';
import { parsePaymentExternalReference } from '@/app/api/payments/payment-reference';
import { MercadoPagoPaymentStatus } from '@/types/payments';
import { env } from '@/lib/env';

const mpAccessToken = env.MERCADOPAGO_ACCESS_TOKEN();

/**
 * POST /api/payments/verify
 * Verifies the latest payment for the authenticated user and activates the subscription if approved.
 * Useful when the webhook didn't fire or was delayed.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (!auth) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    // Get current subscription to find payment ID
    const subSnap = await adminDb.collection('subscriptions').doc(auth.uid).get();
    if (!subSnap.exists) {
      return NextResponse.json({ error: 'No hay suscripción pendiente', status: 'none' }, { status: 404 });
    }

    const subData = subSnap.data();

    // If already active, just return current status
    if (subData?.status === SubscriptionStatus.Active) {
      return NextResponse.json({
        status: SubscriptionStatus.Active,
        planId: subData.planId,
        message: 'La suscripción ya está activa'
      });
    }

    const paymentId = subData?.mpPaymentId;
    if (!paymentId) {
      return NextResponse.json({ error: 'No hay ID de pago registrado', status: 'no_payment' }, { status: 404 });
    }

    // Verify with MercadoPago
    const client = new MercadoPagoConfig({ accessToken: mpAccessToken });
    const paymentClient = new Payment(client);
    const payment = await paymentClient.get({ id: Number(paymentId) });

    const now = new Date();
    const endDate = await calculateSmartEndDate(auth.uid);

    const paymentReference = parsePaymentExternalReference(payment.external_reference);
    const planId = subData?.pendingPlanId || paymentReference?.planId || subData?.planId;

    if (!planId) {
      return NextResponse.json({ error: 'No se pudo resolver el plan asociado al pago' }, { status: 400 });
    }

    if (payment.status === MercadoPagoPaymentStatus.Approved) {
      await adminDb.collection('subscriptions').doc(auth.uid).set({
        userId: auth.uid,
        planId: planId as PlanId,
        status: SubscriptionStatus.Active,
        mpPaymentId: String(paymentId),
        mpMerchantOrderId: payment.order?.id ? String(payment.order.id) : null,
        startDate: now.toISOString(),
        endDate: endDate.toISOString(),
        pendingPlanId: null,
        updatedAt: now.toISOString()
      }, { merge: true });

      await adminDb.collection('users').doc(auth.uid).set({
        subscription: {
          planId: planId as PlanId,
          status: SubscriptionStatus.Active,
          startDate: now.toISOString(),
          endDate: endDate.toISOString()
        }
      }, { merge: true });

      console.debug(`[Verify] Subscription activated for user ${auth.uid}, plan: ${planId}`);
      return NextResponse.json({
        status: SubscriptionStatus.Active,
        planId,
        message: 'Suscripción activada correctamente'
      });
    } else {
      console.debug(`[Verify] Payment ${paymentId} status: ${payment.status} for user ${auth.uid}`);
      return NextResponse.json({
        status: payment.status,
        planId,
        message: `El pago está en estado: ${payment.status}`
      });
    }
  } catch (error: unknown) {
    console.error('[Verify] Error:', getErrorMessage(error));
    return NextResponse.json(
      { error: getErrorMessage(error, 'Error al verificar pago') },
      { status: 500 }
    );
  }
}
