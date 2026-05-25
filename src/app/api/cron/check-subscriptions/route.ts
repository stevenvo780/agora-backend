import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminDb } from '@/lib/firebase-admin';
import { getErrorMessage } from '@/lib/error-utils';
import { Plan, SubscriptionStatus } from '@/types/subscription';
import { env } from '@/lib/env';
import { timingSafeEqual } from 'node:crypto';

/**
 * GET /api/cron/check-subscriptions
 *
 * Cron job que corre 1x/día para marcar como expiradas las suscripciones
 * cuyo endDate ya pasó. Complementa la verificación lazy de subscription-status.
 *
 * Protegido por CRON_SECRET. Acepta el secret en `Authorization: Bearer <secret>`
 * (Vercel cron / citations-backfill style) o en `x-cron-secret: <secret>`
 * (Cloud Scheduler legacy) — así no depende de cómo esté armado el job.
 */
const safeEqual = (value: string, expected: string): boolean => {
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

const isAuthorized = (req: NextRequest, secret: string): boolean => {
  const authHeader = req.headers.get('authorization') ?? '';
  if (authHeader && safeEqual(authHeader, `Bearer ${secret}`)) return true;
  const cronHeader = req.headers.get('x-cron-secret') ?? '';
  if (cronHeader && safeEqual(cronHeader, secret)) return true;
  return false;
};

export async function GET(req: NextRequest) {
  const cronSecret = env.CRON_SECRET();
  if (!cronSecret) {
    console.warn('[Cron] CRON_SECRET not configured — refusing to run');
    return NextResponse.json({ error: 'Cron not configured' }, { status: 503 });
  }

  if (!isAuthorized(req, cronSecret)) {
    console.warn('[Cron] Unauthorized cron attempt');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const now = new Date();
    const nowIso = now.toISOString();

    // Buscar suscripciones activas cuyo endDate ya pasó
    const expiredSnap = await adminDb
      .collection('subscriptions')
      .where('status', '==', 'active')
      .where('endDate', '<=', nowIso)
      .get();

    if (expiredSnap.empty) {
      console.debug('[Cron] No expired subscriptions found');
      return NextResponse.json({
        message: 'No expired subscriptions',
        checked: 0,
        expired: 0
      });
    }

    const batch = adminDb.batch();
    const expiredUserIds: string[] = [];

    for (const doc of expiredSnap.docs) {
      const data = doc.data();
      const userId = doc.id;
      expiredUserIds.push(userId);

      // Marcar suscripción como expirada
      batch.update(doc.ref, {
        status: SubscriptionStatus.Expired,
        updatedAt: nowIso
      });

      // Sincronizar en users/
      const userRef = adminDb.collection('users').doc(userId);
      batch.set(userRef, {
        subscription: {
          planId: Plan.Free,
          status: SubscriptionStatus.Expired
        }
      }, { merge: true });

      console.debug(`[Cron] Expiring subscription for user ${userId}, plan: ${data.planId}, endDate: ${data.endDate}`);
    }

    await batch.commit();

    console.debug(`[Cron] Expired ${expiredUserIds.length} subscriptions`);

    return NextResponse.json({
      message: `Expired ${expiredUserIds.length} subscriptions`,
      checked: expiredSnap.size,
      expired: expiredUserIds.length,
      userIds: expiredUserIds
    });
  } catch (error: unknown) {
    console.error('[Cron] Error checking subscriptions:', getErrorMessage(error));
    return NextResponse.json(
      { error: getErrorMessage(error, 'Error checking subscriptions') },
      { status: 500 }
    );
  }
}
