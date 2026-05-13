import { NextRequest } from '@/lib/http/next-server';
import { adminAuth, adminDb } from '@/lib/firebase-admin';
import { verifyLocalDevAuthToken } from '@/lib/local-dev-auth';
import { isPersonalWorkspaceId } from '@/types/workspace';
import { validateWorkspaceId } from '@/lib/agora-ai/streamRequestValidation';

export type AuthContext = {
  uid: string;
  email?: string | null;
};

export const getTokenFromRequest = (req: NextRequest) => {
  const header = req.headers.get('authorization') || req.headers.get('Authorization');
  if (header) {
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
};

const allowInsecureAuth = process.env.NEXT_PUBLIC_ALLOW_INSECURE_AUTH === 'true';
const INSECURE_UID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

export const requireAuth = async (req: NextRequest): Promise<AuthContext | null> => {
  const token = getTokenFromRequest(req);

  if (!token) return null;

  try {
    const decoded = await adminAuth.verifyIdToken(token);
    const email = decoded.email ?? (decoded as { userEmail?: string }).userEmail ?? null;
    return { uid: decoded.uid, email };
  } catch {
    const localDevAuth = verifyLocalDevAuthToken(token);
    if (localDevAuth) {
      return localDevAuth;
    }
    if (allowInsecureAuth && INSECURE_UID_PATTERN.test(token)) {
      return { uid: token, email: null };
    }
    return null;
  }
};

// In-memory cache for workspace membership — avoids 1 Firestore read per API request
const _membershipCache = new Map<string, { result: boolean; ts: number }>();
const MEMBERSHIP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

export const isWorkspaceMember = async (workspaceId: string, uid: string): Promise<boolean> => {
  if (isPersonalWorkspaceId(workspaceId)) return false;
  if (allowInsecureAuth) return true;

  // Defense-in-depth: rechazar wsId con path-traversal/control chars antes
  // de tocar Firestore. Los callers ya deberían validar, pero esto evita
  // que cualquier endpoint nuevo que olvide validar abra el path injection.
  const validated = validateWorkspaceId(workspaceId);
  if (!validated) return false;

  const cacheKey = `${validated}::${uid}`;
  const cached = _membershipCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < MEMBERSHIP_CACHE_TTL_MS) {
    return cached.result;
  }

  const snap = await adminDb.collection('workspaces').doc(validated).get();
  if (!snap.exists) {
    _membershipCache.set(cacheKey, { result: false, ts: Date.now() });
    return false;
  }
  const data = snap.data() as { members?: string[] } | undefined;
  const members = Array.isArray(data?.members) ? data?.members : [];
  const result = members.includes(uid);
  _membershipCache.set(cacheKey, { result, ts: Date.now() });

  // Evict stale entries periodically
  if (_membershipCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of _membershipCache) {
      if (now - v.ts > MEMBERSHIP_CACHE_TTL_MS) _membershipCache.delete(k);
    }
  }

  return result;
};

/** Force-clear membership cache (e.g. after invite/accept/remove). */
export const invalidateMembershipCache = (workspaceId: string) => {
  for (const key of _membershipCache.keys()) {
    if (key.startsWith(`${workspaceId}::`)) _membershipCache.delete(key);
  }
};

/** Clear entire membership cache — for tests only. */
export const _clearMembershipCacheForTesting = () => {
  _membershipCache.clear();
};

export const getUserRole = async (uid: string): Promise<string | null> => {
  if (!uid) return null;
  try {
    const snap = await adminDb.collection('users').doc(uid).get();
    if (!snap.exists) return null;
    const data = snap.data() as { role?: string } | undefined;
    if (typeof data?.role === 'string' && data.role.trim()) {
      return data.role.trim();
    }
  } catch (error) {
    console.warn('Failed to load user role:', error);
  }
  return null;
};

export const isAdminUser = async (uid: string): Promise<boolean> => {
  const role = await getUserRole(uid);
  if (!role) return false;
  const normalized = role.toLowerCase();
  return normalized === 'admin' || normalized === 'superadmin';
};
