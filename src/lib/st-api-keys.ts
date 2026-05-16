import crypto from 'node:crypto';
import { adminDb } from '@/lib/firebase-admin';

export interface STApiKey {
  hash: string;
  owner: string;
  scope: 'public-eval' | 'public-derive';
  quota: { dailyLimit: number; usedToday: number; resetAt: string };
  createdAt: string;
  disabled?: boolean;
}

const COLLECTION = 'stApiKeys';

function hashKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function tomorrowResetAt(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

export async function lookupApiKey(rawKey: string): Promise<STApiKey | null> {
  const hash = hashKey(rawKey);
  const doc = await adminDb.collection(COLLECTION).doc(hash).get();
  if (!doc.exists) return null;
  const data = doc.data() as STApiKey;
  if (data.disabled === true) return null;

  const today = todayIsoDate();
  const resetAt = data.quota.resetAt ?? '';
  if (resetAt.slice(0, 10) <= today && data.quota.usedToday > 0) {
    const resetDate = tomorrowResetAt();
    const reset: STApiKey = {
      ...data,
      quota: { ...data.quota, usedToday: 0, resetAt: resetDate }
    };
    await adminDb.collection(COLLECTION).doc(hash).update({
      'quota.usedToday': 0,
      'quota.resetAt': resetDate
    });
    return reset;
  }

  return data;
}

export async function consumeQuota(key: STApiKey): Promise<boolean> {
  if (key.quota.usedToday >= key.quota.dailyLimit) return false;
  await adminDb.collection(COLLECTION).doc(key.hash).update({
    'quota.usedToday': key.quota.usedToday + 1
  });
  return true;
}

export async function createApiKey(
  owner: string,
  scope: STApiKey['scope'],
  dailyLimit = 1000
): Promise<{ key: string; hash: string }> {
  const rawKey = crypto.randomBytes(32).toString('hex');
  const hash = hashKey(rawKey);
  const now = new Date().toISOString();
  const record: STApiKey = {
    hash,
    owner,
    scope,
    quota: { dailyLimit, usedToday: 0, resetAt: tomorrowResetAt() },
    createdAt: now
  };
  await adminDb.collection(COLLECTION).doc(hash).set(record);
  return { key: rawKey, hash };
}
