export enum Plan {
  Free = 'free',
  Basic = 'basic',
  Pro = 'pro',
  Enterprise = 'enterprise'
}

export type PlanId = `${Plan}`;

export const PLAN_IDS = Object.values(Plan) as PlanId[];
export const PLAN_ORDER = [Plan.Free, Plan.Basic, Plan.Pro, Plan.Enterprise] as const satisfies readonly PlanId[];

const PLAN_ID_SET = new Set<PlanId>(PLAN_IDS);

export const isPlanId = (value: string): value is PlanId => PLAN_ID_SET.has(value as PlanId);

export enum SubscriptionStatus {
  Active = 'active',
  Pending = 'pending',
  Cancelled = 'cancelled',
  Expired = 'expired',
  Free = 'free'
}

export type SubscriptionStatusId = `${SubscriptionStatus}`;

export interface PlanConfig {
  id: PlanId;
  name: string;
  price: number; // COP
  currency: string;
  features: string[];
  hasTerminals: boolean;
  hasDedicatedMachine: boolean;
  contactRequired: boolean;
  storageLimitMB: number;
}

export const PLANS: Record<PlanId, PlanConfig> = {
  [Plan.Free]: {
    id: Plan.Free,
    name: 'Gratuito',
    price: 0,
    currency: 'COP',
    features: [
      'Acceso al editor',
      'Documentos ilimitados',
      'Workspaces personales',
      '50 MB de almacenamiento'
    ],
    hasTerminals: false,
    hasDedicatedMachine: false,
    contactRequired: false,
    storageLimitMB: 50
  },
  [Plan.Basic]: {
    id: Plan.Basic,
    name: 'Básico',
    price: 30000,
    currency: 'COP',
    features: [
      'Todo lo del plan Gratuito',
      'Workspaces colaborativos',
      'Tableros Kanban',
      'Soporte por email',
      '1 GB de almacenamiento'
    ],
    hasTerminals: false,
    hasDedicatedMachine: false,
    contactRequired: false,
    storageLimitMB: 1024
  },
  [Plan.Pro]: {
    id: Plan.Pro,
    name: 'Pro',
    price: 80000,
    currency: 'COP',
    features: [
      'Todo lo del plan Básico',
      'Terminales ilimitadas',
      'Acceso completo a workers',
      'Soporte prioritario',
      '1 GB de almacenamiento'
    ],
    hasTerminals: true,
    hasDedicatedMachine: false,
    contactRequired: false,
    storageLimitMB: 1024
  },
  [Plan.Enterprise]: {
    id: Plan.Enterprise,
    name: 'Enterprise',
    price: 240000,
    currency: 'COP',
    features: [
      'Todo lo del plan Pro',
      'Máquina dedicada',
      'Terminal dedicada',
      'Soporte personalizado',
      'Configuración a medida',
      '10 GB de almacenamiento'
    ],
    hasTerminals: true,
    hasDedicatedMachine: true,
    contactRequired: true,
    storageLimitMB: 10240
  }
};

export interface UserSubscription {
  id?: string;
  userId: string;
  planId: PlanId;
  status: SubscriptionStatusId;
  mpPaymentId?: string;
  mpPreferenceId?: string;
  mpMerchantOrderId?: string;
  startDate?: string;
  endDate?: string;
  createdAt: string;
  updatedAt: string;
}

export function canAccessTerminals(planId: PlanId): boolean {
  return PLANS[planId]?.hasTerminals ?? false;
}

export function getPlanById(planId: PlanId): PlanConfig {
  return PLANS[planId] ?? PLANS[Plan.Free];
}

export function getStorageLimitMB(planId: PlanId): number {
  return PLANS[planId]?.storageLimitMB ?? PLANS[Plan.Free].storageLimitMB;
}

export function formatStorageSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB`;
  return `${mb} MB`;
}
