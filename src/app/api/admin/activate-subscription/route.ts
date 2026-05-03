import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminDb } from '@/lib/firebase-admin';
import { getErrorMessage } from '@/lib/error-utils';
import { PLAN_IDS, Plan, SubscriptionStatus, isPlanId, type PlanId } from '@/types/subscription';
import { env } from '@/lib/env';

const ADMIN_PASSWORD = env.ADMIN_PASSWORD();
const ENABLE_ADMIN_ENDPOINTS = env.ENABLE_ADMIN_ENDPOINTS();

/**
 * POST /api/admin/activate-subscription
 * Admin endpoint to manually activate a subscription for a user.
 * DISABLED in production unless ENABLE_ADMIN_ENDPOINTS=true.
 * Requires APP_PASSWORD header for authentication.
 *
 * Body: { userId: string, planId: 'basic' | 'pro' | 'enterprise', durationMonths?: number }
 */
export async function POST(req: NextRequest) {
  // Block in production unless explicitly enabled
  if (!ENABLE_ADMIN_ENDPOINTS) {
    return NextResponse.json({ error: 'Endpoint deshabilitado' }, { status: 403 });
  }

  try {
    const authHeader = req.headers.get('x-admin-password') || '';
    if (!ADMIN_PASSWORD || authHeader !== ADMIN_PASSWORD) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const body = await req.json();
    const { userId, planId, durationMonths = 1 } = body;

    if (!userId || !planId) {
      return NextResponse.json({ error: 'userId y planId son requeridos' }, { status: 400 });
    }

    if (typeof planId !== 'string' || !isPlanId(planId)) {
      return NextResponse.json({ error: `Plan inválido. Usar: ${PLAN_IDS.join(', ')}` }, { status: 400 });
    }

    const now = new Date();
    const endDate = new Date(now);
    endDate.setMonth(endDate.getMonth() + durationMonths);

    if (planId === Plan.Free) {
      // Reset to free plan
      await adminDb.collection('subscriptions').doc(userId).delete();
      await adminDb.collection('users').doc(userId).set({
        subscription: {
          planId: Plan.Free,
          status: SubscriptionStatus.Free
        }
      }, { merge: true });

      console.debug(`[Admin] Subscription reset to free for user ${userId}`);
      return NextResponse.json({
        success: true,
        userId,
        planId: Plan.Free,
        status: SubscriptionStatus.Free,
        message: 'Suscripción reseteada a plan gratuito'
      });
    }

    // Update subscription
    await adminDb.collection('subscriptions').doc(userId).set({
      userId,
      planId: planId as PlanId,
      status: SubscriptionStatus.Active,
      mpPaymentId: `admin-manual-${Date.now()}`,
      startDate: now.toISOString(),
      endDate: endDate.toISOString(),
      updatedAt: now.toISOString(),
      activatedBy: 'admin'
    }, { merge: true });

    // Update user document
    await adminDb.collection('users').doc(userId).set({
      subscription: {
        planId: planId as PlanId,
        status: SubscriptionStatus.Active,
        startDate: now.toISOString(),
        endDate: endDate.toISOString()
      }
    }, { merge: true });

    console.debug(`[Admin] Subscription manually activated for user ${userId}, plan: ${planId}, duration: ${durationMonths} month(s)`);

    return NextResponse.json({
      success: true,
      userId,
      planId,
      status: SubscriptionStatus.Active,
      startDate: now.toISOString(),
      endDate: endDate.toISOString(),
      message: `Suscripción al plan ${planId} activada manualmente por ${durationMonths} mes(es)`
    });
  } catch (error: unknown) {
    console.error('[Admin] Error activating subscription:', getErrorMessage(error));
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 });
  }
}
