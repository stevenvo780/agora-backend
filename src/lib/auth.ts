import type { Request, Response } from 'express';
import { auth, firestore } from './firebaseAdmin.js';

export interface AuthInfo {
  uid: string;
  email?: string | null;
  token: string;
}

export async function authenticateRequest(req: Request, res: Response): Promise<AuthInfo | null> {
  const header = req.header('authorization');
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    res.status(401).json({ error: 'unauthorized', message: 'Falta header Authorization: Bearer <token>' });
    return null;
  }
  try {
    const decoded = await auth().verifyIdToken(token);
    return { uid: decoded.uid, email: decoded.email ?? null, token };
  } catch (e) {
    console.warn('[auth] verifyIdToken failed', (e as Error).message);
    res.status(403).json({ error: 'forbidden', message: 'Token inválido o expirado' });
    return null;
  }
}

const PERSONAL_PREFIX = 'personal:';

export function isPersonalWorkspaceId(workspaceId: string): boolean {
  return workspaceId === 'personal' || workspaceId.startsWith(PERSONAL_PREFIX);
}

export async function isWorkspaceMember(workspaceId: string, uid: string): Promise<boolean> {
  if (isPersonalWorkspaceId(workspaceId)) {
    // 'personal' es el alias del usuario actual; 'personal:<uid>' debe coincidir.
    if (workspaceId === 'personal') return true;
    return workspaceId === `${PERSONAL_PREFIX}${uid}`;
  }
  try {
    const doc = await firestore().collection('workspaces').doc(workspaceId).get();
    if (!doc.exists) return false;
    const data = doc.data() as { members?: string[]; ownerUid?: string } | undefined;
    if (!data) return false;
    if (data.ownerUid === uid) return true;
    if (Array.isArray(data.members) && data.members.includes(uid)) return true;
    return false;
  } catch (e) {
    console.error('[auth] isWorkspaceMember error', e);
    return false;
  }
}
