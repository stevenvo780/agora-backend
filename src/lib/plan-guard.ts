/**
 * Guards server-side de planes y cuotas.
 *
 * - `getActivePlan(uid)` — lee la suscripción del user y aplica auto-expiry.
 * - `requirePlan(uid, allowed)` — devuelve null si OK, NextResponse 403 si no.
 * - `enforceStorageQuota(uid, addBytes)` — chequea que el user no exceda
 *   `storageLimitMB` del plan al subir un archivo nuevo.
 */
import { NextResponse } from '@/lib/http/next-server';
import { adminDb } from '@/lib/firebase-admin';
import {
    Plan,
    PLAN_ORDER,
    SubscriptionStatus,
    canAccessTerminals,
    getStorageLimitMB,
    type PlanId,
    type UserSubscription
} from '@/types/subscription';
import { calculateOwnedStorageUsageBytes } from '@/lib/storage-usage';

interface ActivePlan {
    planId: PlanId;
    status: string;
    endDate: string | null;
}

const FREE: ActivePlan = { planId: Plan.Free, status: SubscriptionStatus.Free, endDate: null };

export const getActivePlan = async (uid: string): Promise<ActivePlan> => {
    const ref = adminDb.collection('subscriptions').doc(uid);
    const snap = await ref.get();
    if (!snap.exists) return FREE;
    const data = snap.data() as UserSubscription;
    if (data.status === SubscriptionStatus.Active && data.endDate) {
        if (new Date(data.endDate) < new Date()) {
            await ref.update({ status: SubscriptionStatus.Expired, updatedAt: new Date().toISOString() }).catch(() => undefined);
            return { planId: Plan.Free, status: SubscriptionStatus.Expired, endDate: data.endDate };
        }
    }
    return {
        planId: data.planId ?? Plan.Free,
        status: data.status ?? SubscriptionStatus.Free,
        endDate: data.endDate ?? null
    };
};

const planRank = (id: PlanId): number => (PLAN_ORDER as readonly PlanId[]).indexOf(id);

/**
 * Acepta una lista explícita de planes permitidos o un plan mínimo:
 *   requirePlan(uid, ['pro', 'enterprise'])
 *   requirePlan(uid, { atLeast: 'basic' })
 */
export const requirePlan = async (
    uid: string,
    allowed: PlanId[] | { atLeast: PlanId }
): Promise<NextResponse | null> => {
    const plan = await getActivePlan(uid);
    let ok = false;
    if (Array.isArray(allowed)) ok = allowed.includes(plan.planId);
    else ok = planRank(plan.planId) >= planRank(allowed.atLeast);
    if (ok) return null;
    return NextResponse.json({
        error: 'plan-required',
        currentPlan: plan.planId,
        message: 'Tu plan actual no incluye esta función. Actualiza para acceder.'
    }, { status: 403 });
};

/**
 * Chequea que `currentBytes + addBytes <= limitMB * 1024 * 1024`.
 * Devuelve NextResponse 413 si excede, null si OK.
 */
export const enforceStorageQuota = async (uid: string, addBytes: number): Promise<NextResponse | null> => {
    const plan = await getActivePlan(uid);
    const limitMB = getStorageLimitMB(plan.planId);
    const limitBytes = limitMB * 1024 * 1024;
    const usedBytes = await calculateOwnedStorageUsageBytes(uid);
    if (usedBytes + addBytes > limitBytes) {
        return NextResponse.json({
            error: 'storage-quota-exceeded',
            currentPlan: plan.planId,
            usedBytes,
            limitBytes,
            wouldAddBytes: addBytes,
            message: `Excede tu cuota (${(usedBytes / 1024 / 1024).toFixed(1)} / ${limitMB} MB). Actualiza tu plan.`
        }, { status: 413 });
    }
    return null;
};

export const requireTerminalAccess = async (uid: string): Promise<NextResponse | null> => {
    const plan = await getActivePlan(uid);
    if (canAccessTerminals(plan.planId)) return null;
    return NextResponse.json({
        error: 'plan-required',
        feature: 'terminals',
        currentPlan: plan.planId,
        message: 'Las terminales requieren plan Pro o superior.'
    }, { status: 403 });
};
