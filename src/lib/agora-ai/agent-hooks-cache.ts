import { adminDb } from '@/lib/firebase-admin';

type HooksConfig = {
  preToolUse?: string[];
  postToolUse?: string[];
  userPromptSubmit?: string[];
};

type CacheEntry = {
  value: HooksConfig | null;
  expiresAt: number;
};

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

export async function getAgentHooksCached(uid: string): Promise<HooksConfig | null> {
  const now = Date.now();
  const entry = cache.get(uid);
  if (entry && entry.expiresAt > now) {
    return entry.value;
  }

  try {
    const snap = await adminDb.collection('users').doc(uid).collection('agentHooks').doc('config').get();
    const value = snap.exists ? (snap.data() as HooksConfig) : null;
    cache.set(uid, { value, expiresAt: now + TTL_MS });
    return value;
  } catch {
    return null;
  }
}
