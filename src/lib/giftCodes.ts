import { isPlanId, type PlanId } from '@/types/subscription';

export type GiftCodeStatus = 'active' | 'redeemed' | 'disabled';

export interface GiftCode {
  code: string;
  planId: PlanId;
  durationMonths: number;
  status: GiftCodeStatus;
  redeemedBy: string | null;
  redeemedAt: string | null;
  createdAt: string;
  batch: string;
}

const CODE_REGEX = /^AGORA-[A-Z2-9]{5}-[A-Z2-9]{5}$/;

export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isValidCodeFormat(code: string): boolean {
  return CODE_REGEX.test(code);
}

export function parseGiftCodeDoc(raw: unknown): GiftCode | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const code = typeof obj['code'] === 'string' ? obj['code'] : null;
  const planId = typeof obj['planId'] === 'string' ? obj['planId'] : null;
  const durationMonths = typeof obj['durationMonths'] === 'number' ? obj['durationMonths'] : null;
  const status = typeof obj['status'] === 'string' ? obj['status'] : null;
  const createdAt = typeof obj['createdAt'] === 'string' ? obj['createdAt'] : null;
  const batch = typeof obj['batch'] === 'string' ? obj['batch'] : '';

  if (!code || !planId || durationMonths === null || !status || !createdAt) return null;
  if (!isPlanId(planId)) return null;
  if (status !== 'active' && status !== 'redeemed' && status !== 'disabled') return null;
  if (!Number.isInteger(durationMonths) || durationMonths < 1) return null;

  return {
    code,
    planId,
    durationMonths,
    status,
    redeemedBy: typeof obj['redeemedBy'] === 'string' ? obj['redeemedBy'] : null,
    redeemedAt: typeof obj['redeemedAt'] === 'string' ? obj['redeemedAt'] : null,
    createdAt,
    batch
  };
}

export function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}
