import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth } from '@/lib/server-auth';
import { adminDb } from '@/lib/firebase-admin';
import { getErrorMessage } from '@/lib/error-utils';
import { SubscriptionStatus } from '@/types/subscription';
import { normalizeCode, isValidCodeFormat, parseGiftCodeDoc, addMonths } from '@/lib/giftCodes';
import { readJsonBody } from '@/lib/http/read-json-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (!auth) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const body = await readJsonBody(req);
    if (!body.ok) return body.response;

    const rawCode = body.value['code'];
    if (typeof rawCode !== 'string' || rawCode.trim().length === 0) {
      return NextResponse.json({ error: 'El campo "code" es requerido' }, { status: 400 });
    }

    const code = normalizeCode(rawCode);
    if (!isValidCodeFormat(code)) {
      return NextResponse.json({ error: 'Formato de código inválido' }, { status: 400 });
    }

    const giftRef = adminDb.collection('giftCodes').doc(code);
    const subRef = adminDb.collection('subscriptions').doc(auth.uid);
    const userRef = adminDb.collection('users').doc(auth.uid);

    const result = await adminDb.runTransaction(async (tx) => {
      const giftSnap = await tx.get(giftRef);
      if (!giftSnap.exists) {
        return { ok: false, status: 404, error: 'Código no encontrado' } as const;
      }

      const giftDoc = parseGiftCodeDoc(giftSnap.data());
      if (!giftDoc) {
        return { ok: false, status: 422, error: 'Código con datos inválidos' } as const;
      }

      if (giftDoc.status !== 'active') {
        return { ok: false, status: 409, error: 'El código ya fue usado o está deshabilitado' } as const;
      }

      const now = new Date();
      const endDate = addMonths(now, giftDoc.durationMonths);

      tx.update(giftRef, {
        status: 'redeemed',
        redeemedBy: auth.uid,
        redeemedAt: now.toISOString()
      });

      const subscriptionData = {
        userId: auth.uid,
        planId: giftDoc.planId,
        status: SubscriptionStatus.Active,
        startDate: now.toISOString(),
        endDate: endDate.toISOString(),
        mpPaymentId: `gift:${code}`,
        updatedAt: now.toISOString()
      };

      tx.set(subRef, subscriptionData, { merge: true });

      tx.set(userRef, {
        subscription: {
          planId: giftDoc.planId,
          status: SubscriptionStatus.Active,
          startDate: now.toISOString(),
          endDate: endDate.toISOString()
        }
      }, { merge: true });

      return {
        ok: true,
        planId: giftDoc.planId,
        durationMonths: giftDoc.durationMonths,
        endDate: endDate.toISOString()
      } as const;
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    console.warn(`[gift-codes/redeem] Code ${code} redeemed by ${auth.uid}, plan ${result.planId} for ${result.durationMonths}m`);

    return NextResponse.json({
      ok: true,
      planId: result.planId,
      durationMonths: result.durationMonths,
      endDate: result.endDate
    });
  } catch (error: unknown) {
    console.error('[gift-codes/redeem] Error:', getErrorMessage(error));
    return NextResponse.json(
      { error: getErrorMessage(error, 'Error al canjear el código') },
      { status: 500 }
    );
  }
}
