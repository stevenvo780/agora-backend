import { adminDb } from '@/lib/firebase-admin';
import { Plan, SubscriptionStatus, type PlanId } from '@/types/subscription';

/**
 * Calcula la nueva fecha de expiración de manera inteligente:
 * - Si el usuario tiene una suscripción activa con endDate > now, extiende desde endDate
 * - Si no tiene suscripción o ya expiró, calcula desde now
 * Esto evita que el usuario pierda días al renovar antes de que expire su plan.
 */
export async function calculateSmartEndDate(userId: string): Promise<Date> {
  const now = new Date();

  try {
    const snap = await adminDb.collection('subscriptions').doc(userId).get();
    if (snap.exists) {
      const data = snap.data();
      if (data?.endDate && data?.status === 'active') {
        const currentEndDate = new Date(data.endDate);
        if (currentEndDate > now) {
          // Renovación anticipada: extender desde la fecha de expiración actual
          const newEndDate = new Date(currentEndDate);
          newEndDate.setMonth(newEndDate.getMonth() + 1);
          return newEndDate;
        }
      }
    }
  } catch (error) {
    console.error('[calculateSmartEndDate] Error reading current subscription:', error);
  }

  // Sin suscripción activa o ya expiró: calcular desde ahora
  const endDate = new Date(now);
  endDate.setMonth(endDate.getMonth() + 1);
  return endDate;
}

export async function getActivePlanId(userId: string): Promise<PlanId> {
  const snap = await adminDb.collection('subscriptions').doc(userId).get();
  if (!snap.exists) {
    return Plan.Free;
  }

  const data = snap.data();
  if (data?.status === SubscriptionStatus.Active && typeof data.planId === 'string') {
    return data.planId as PlanId;
  }

  return Plan.Free;
}
