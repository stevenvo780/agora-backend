import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { MercadoPagoConfig, Payment } from 'mercadopago';
import { adminDb } from '@/lib/firebase-admin';
import { getErrorMessage } from '@/lib/error-utils';
import { SubscriptionStatus, type PlanId } from '@/types/subscription';
import { calculateSmartEndDate } from '@/app/api/payments/helpers';
import { parsePaymentExternalReference } from '@/app/api/payments/payment-reference';
import { MercadoPagoPaymentStatus, PaymentRedirectStatus } from '@/types/payments';
import { env } from '@/lib/env';

const mpAccessToken = env.MERCADOPAGO_ACCESS_TOKEN();

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const paymentId = searchParams.get('payment_id') || searchParams.get('collection_id') || '';
  const queryReference = parsePaymentExternalReference(searchParams.get('external_reference') || '');

  const appUrl = env.APP_BASE_URL();
  const redirectUrl = new URL(`${appUrl}/dashboard`);
  redirectUrl.searchParams.set('payment', PaymentRedirectStatus.Pending);

  // Verify payment - it might already be approved by the time callback fires
  try {
    if (paymentId && paymentId !== 'null') {
      console.debug(`[Callback/Pending] Processing payment ${paymentId}`);

      const client = new MercadoPagoConfig({ accessToken: mpAccessToken });
      const paymentClient = new Payment(client);
      const payment = await paymentClient.get({ id: Number(paymentId) });
      const paymentReference = parsePaymentExternalReference(payment.external_reference);

      if (!paymentReference) {
        console.warn(`[Callback/Pending] Missing or invalid external_reference for payment ${paymentId}`);
        redirectUrl.searchParams.set('payment', PaymentRedirectStatus.Failure);
        return NextResponse.redirect(redirectUrl.toString());
      }

      if (
        queryReference &&
        (queryReference.userId !== paymentReference.userId || queryReference.planId !== paymentReference.planId)
      ) {
        console.warn(
          `[Callback/Pending] Ignoring mismatched query external_reference for payment ${paymentId}; using payment record reference`
        );
      }

      const { userId, planId } = paymentReference;
      redirectUrl.searchParams.set('plan', planId);

      const now = new Date();

      // Leer suscripción actual para deduplicación y protección
      const existingSub = await adminDb.collection('subscriptions').doc(userId).get();
      const existingData = existingSub.exists ? existingSub.data() : null;

      if (payment.status === MercadoPagoPaymentStatus.Approved) {
        // Deduplicación: si ya se activó con este paymentId, no extender
        if (existingData?.status === SubscriptionStatus.Active && existingData?.mpPaymentId === String(paymentId)) {
          console.debug(`[Callback/Pending] Payment ${paymentId} already processed for user ${userId}, skipping`);
        } else {
          const endDate = await calculateSmartEndDate(userId);

          await adminDb.collection('subscriptions').doc(userId).set({
            userId,
            planId: planId as PlanId,
            status: SubscriptionStatus.Active,
            mpPaymentId: String(paymentId),
            mpMerchantOrderId: payment.order?.id ? String(payment.order.id) : null,
            startDate: now.toISOString(),
            endDate: endDate.toISOString(),
            pendingPlanId: null,
            updatedAt: now.toISOString()
          }, { merge: true });

          await adminDb.collection('users').doc(userId).set({
            subscription: {
              planId: planId as PlanId,
              status: SubscriptionStatus.Active,
              startDate: now.toISOString(),
              endDate: endDate.toISOString()
            }
          }, { merge: true });

          console.debug(`[Callback/Pending] Payment was approved and activated for user ${userId}`);
        }
        redirectUrl.searchParams.set('payment', PaymentRedirectStatus.Success);
      } else {
        // Solo poner pending si NO tiene suscripción activa
        if (existingData?.status === SubscriptionStatus.Active) {
          console.debug(`[Callback/Pending] User ${userId} already has active sub, ignoring pending status`);
        } else {
          await adminDb.collection('subscriptions').doc(userId).set({
            userId,
            planId: planId as PlanId,
            status: SubscriptionStatus.Pending,
            mpPaymentId: String(paymentId),
            updatedAt: now.toISOString()
          }, { merge: true });

          console.debug(`[Callback/Pending] Payment pending for user ${userId}`);
        }
      }
    } else {
      redirectUrl.searchParams.set('payment', PaymentRedirectStatus.Failure);
    }
  } catch (error: unknown) {
    console.error('[Callback/Pending] Error verifying payment:', getErrorMessage(error));
    redirectUrl.searchParams.set('payment', PaymentRedirectStatus.Failure);
  }

  return NextResponse.redirect(redirectUrl.toString());
}
