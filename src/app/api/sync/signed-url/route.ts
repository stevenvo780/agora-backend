import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth, isWorkspaceMember } from '@/lib/server-auth';

export const runtime = 'nodejs';
import { isPersonalWorkspaceId } from '@/types/workspace';
import { presignGet, presignPut, isNasConfigured } from '@/lib/nas-storage';
import { adminDb } from '@/lib/firebase-admin';
import { getErrorMessage } from '@/lib/error-utils';

const PUT_TTL = 15 * 60;
const GET_TTL = 60 * 60;

const canAccessPath = async (storagePath: string, uid: string): Promise<boolean> => {
  const m = storagePath.match(/^users\/([^/]+)\//);
  if (m) return m[1] === uid;
  const w = storagePath.match(/^workspaces\/([^/]+)\//);
  if (w) {
    if (isPersonalWorkspaceId(w[1])) return false;
    return isWorkspaceMember(w[1], uid);
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
