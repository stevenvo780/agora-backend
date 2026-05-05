import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth, isWorkspaceMember } from '@/lib/server-auth';

export const runtime = 'nodejs';
import path from 'node:path';
import { isPersonalWorkspaceId } from '@/types/workspace';
import { presignGet, presignPut, isNasConfigured } from '@/lib/nas-storage';
import { adminDb } from '@/lib/firebase-admin';
import { getErrorMessage } from '@/lib/error-utils';
import { enforceStorageQuota } from '@/lib/plan-guard';

const PUT_TTL = 15 * 60;
const GET_TTL = 60 * 60;

const isSafeStoragePath = (storagePath: string): boolean => {
  if (!storagePath) return false;
  if (storagePath.includes('\0')) return false;
  if (storagePath.includes('\\')) return false;
  if (storagePath.startsWith('/')) return false;
  if (storagePath.includes('//')) return false;
  const segments = storagePath.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  const normalized = path.posix.normalize(storagePath);
  if (normalized !== storagePath) return false;
  return true;
};

const canAccessPath = async (storagePath: string, uid: string): Promise<boolean> => {
  if (!isSafeStoragePath(storagePath)) return false;
  const m = storagePath.match(/^users\/([^/]+)\//);
  if (m) return m[1] === uid;
  const w = storagePath.match(/^workspaces\/([^/]+)\//);
  if (w) {
    const wsId = w[1];
    if (typeof wsId !== 'string' || isPersonalWorkspaceId(wsId)) return false;
    return isWorkspaceMember(wsId, uid);
  }
  return false;
};

export async function POST(req: NextRequest) {
  try {
    if (!isNasConfigured()) {
      return NextResponse.json({ error: 'NAS not configured' }, { status: 503 });
    }
    const auth = await requireAuth(req);
    if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

    const body = await req.json();
    const op: 'get' | 'put' = body.op === 'put' ? 'put' : 'get';
    const path: string | undefined = typeof body.path === 'string' ? body.path : undefined;
    const docId: string | undefined = typeof body.docId === 'string' ? body.docId : undefined;

    let storagePath = path;
    if (!storagePath && docId) {
      const snap = await adminDb.collection('documents').doc(docId).get();
      if (snap.exists) {
        const data = snap.data() as { storagePath?: string } | undefined;
        storagePath = typeof data?.storagePath === 'string' ? data.storagePath : undefined;
      }
    }
    if (!storagePath) {
      return NextResponse.json({ error: 'path or docId required' }, { status: 400 });
    }

    if (!(await canAccessPath(storagePath, auth.uid))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (op === 'put') {
      const addBytes = typeof body.fileSize === 'number' && body.fileSize > 0 ? body.fileSize : 0;
      const quotaResp = await enforceStorageQuota(auth.uid, addBytes);
      if (quotaResp) return quotaResp;
    }

    const url = op === 'put'
      ? await presignPut(storagePath, PUT_TTL, typeof body.contentType === 'string' ? body.contentType : undefined)
      : await presignGet(storagePath, GET_TTL);

    return NextResponse.json({
      op,
      path: storagePath,
      url,
      ttlSeconds: op === 'put' ? PUT_TTL : GET_TTL
    });
  } catch (e: unknown) {
    console.error('[sync/signed-url] error:', getErrorMessage(e));
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
