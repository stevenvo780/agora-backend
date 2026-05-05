import crypto from 'node:crypto';
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminDb } from '@/lib/firebase-admin';
import { getErrorMessage } from '@/lib/error-utils';
import { PLAN_IDS, Plan, SubscriptionStatus, isPlanId, type PlanId } from '@/types/subscription';
import { env } from '@/lib/env';

const ADMIN_PASSWORD = env.ADMIN_PASSWORD();
const ENABLE_ADMIN_ENDPOINTS = env.ENABLE_ADMIN_ENDPOINTS();

function timingSafeStringEqual(provided: string, expected: string): boolean {
  if (!expected) return false;
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const max = Math.max(providedBuf.length, expectedBuf.length);
  const a = Buffer.alloc(max);
  const b = Buffer.alloc(max);
  providedBuf.copy(a);
  expectedBuf.copy(b);
  const equal = crypto.timingSafeEqual(a, b);
  return equal && providedBuf.length === expectedBuf.length;
}

interface ActivateSubscriptionBody {
  userId: string;
  planId: PlanId;
  durationMonths: number;
}

function parseActivateSubscriptionBody(raw: unknown): ActivateSubscriptionBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const userId = obj.userId;
  if (typeof userId !== 'string' || userId.trim().length === 0) return null;
  const planId = obj.planId;
  if (typeof planId !== 'string' || !isPlanId(planId)) return null;
  const rawDuration = obj.durationMonths ?? 1;
  if (typeof rawDuration !== 'number' || !Number.isFinite(rawDuration) || !Number.isInteger(rawDuration)) return null;
  if (rawDuration < 1 || rawDuration > 24) return null;
  return { userId, planId, durationMonths: rawDuration };
}

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
    if (!timingSafeStringEqual(authHeader, ADMIN_PASSWORD)) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return NextResponse.json({ error: 'Body inválido' }, { status: 400 });
    }
    const parsed = parseActivateSubscriptionBody(rawBody);
    if (!parsed) {
      return NextResponse.json(
        { error: `Parámetros inválidos. userId requerido, planId en [${PLAN_IDS.join(', ')}], durationMonths entero entre 1 y 24.` },
        { status: 400 }
      );
    }
    const { userId, planId, durationMonths } = parsed;

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
