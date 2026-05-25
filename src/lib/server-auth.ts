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

/** Resultado del lookup de membership: si pertenece al workspace y con qué rol. */
export type WorkspaceMembership = {
  member: boolean;
  /** owner | member | viewer | null (null = no es miembro). */
  role: 'owner' | 'member' | 'viewer' | null;
};

// In-memory cache for workspace membership — avoids 1 Firestore read per API request
const _membershipCache = new Map<string, { result: WorkspaceMembership; ts: number }>();
const MEMBERSHIP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

/**
 * Lee la membership + rol de un usuario en un workspace en una sola query
 * (cacheada). El rol viene de `memberRoles[uid]`; el owner siempre es 'owner'.
 * Un miembro sin entrada en `memberRoles` se trata como 'member' (writer).
 */
export const getWorkspaceMembership = async (
  workspaceId: string,
  uid: string
): Promise<WorkspaceMembership> => {
  if (isPersonalWorkspaceId(workspaceId)) return { member: false, role: null };
  if (allowInsecureAuth) return { member: true, role: 'owner' };

  // Defense-in-depth: rechazar wsId con path-traversal/control chars antes
  // de tocar Firestore. Los callers ya deberían validar, pero esto evita
  // que cualquier endpoint nuevo que olvide validar abra el path injection.
  const validated = validateWorkspaceId(workspaceId);
  if (!validated) return { member: false, role: null };

  const cacheKey = `${validated}::${uid}`;
  const cached = _membershipCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < MEMBERSHIP_CACHE_TTL_MS) {
    return cached.result;
  }

  const snap = await adminDb.collection('workspaces').doc(validated).get();
  if (!snap.exists) {
    const result: WorkspaceMembership = { member: false, role: null };
    _membershipCache.set(cacheKey, { result, ts: Date.now() });
    return result;
  }
  const data = snap.data() as {
    members?: string[];
    ownerId?: string;
    memberRoles?: Record<string, string>;
  } | undefined;
  const members = Array.isArray(data?.members) ? data?.members : [];
  const isMember = members.includes(uid);

  let role: WorkspaceMembership['role'] = null;
  if (data?.ownerId === uid) {
    role = 'owner';
  } else if (isMember) {
    const assigned = data?.memberRoles?.[uid];
    role = assigned === 'viewer' ? 'viewer' : 'member';
  }

  const result: WorkspaceMembership = { member: isMember || role === 'owner', role };
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

export const isWorkspaceMember = async (workspaceId: string, uid: string): Promise<boolean> => {
  const { member } = await getWorkspaceMembership(workspaceId, uid);
  return member;
};

/**
 * ¿Puede el usuario ESCRIBIR (crear/editar/borrar) en este workspace?
 * owner → sí; member → sí; viewer → NO; no-miembro → NO.
 * Para workspaces personales, el propietario (que NO se resuelve aquí) escribe;
 * los callers de workspaces personales gatean por ownerId directamente.
 */
export const canWriteWorkspace = async (workspaceId: string, uid: string): Promise<boolean> => {
  if (allowInsecureAuth) return true;
  const { role } = await getWorkspaceMembership(workspaceId, uid);
  return role === 'owner' || role === 'member';
};

/** Force-clear membership cache (e.g. after invite/accept/remove/change_role). */
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
