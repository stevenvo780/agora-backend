import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth, isWorkspaceMember } from '@/lib/server-auth';

export const runtime = 'nodejs';
import { isPersonalWorkspaceId } from '@/types/workspace';
import { adminDb } from '@/lib/firebase-admin';
import { presignGet, isNasConfigured } from '@/lib/nas-storage';
import { getErrorMessage } from '@/lib/error-utils';

interface DocData {
  workspaceId?: string;
  ownerId?: string;
  storagePath?: string;
  storageBackend?: string;
  contentHash?: string;
  size?: number;
  version?: number;
  syncState?: string;
  name?: string;
  type?: string;
  folder?: string;
  mimeType?: string;
  updatedAt?: { toDate?: () => Date } | string;
}

const tsString = (v: unknown): string | null => {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && typeof (v as { toDate?: () => Date }).toDate === 'function') {
    return (v as { toDate: () => Date }).toDate().toISOString();
  }
  return null;
};

export async function GET(req: NextRequest) {
  try {
    if (!isNasConfigured()) return NextResponse.json({ error: 'NAS not configured' }, { status: 503 });
    const auth = await requireAuth(req);
    if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const docId = searchParams.get('docId');
    const path = searchParams.get('path');
    const includeUrl = searchParams.get('includeUrl') !== 'false';

    let snapId: string | null = null;
    let data: DocData | undefined;
    if (docId) {
      const snap = await adminDb.collection('documents').doc(docId).get();
      if (snap.exists) { snapId = snap.id; data = snap.data() as DocData; }
    } else if (path) {
      const q = await adminDb.collection('documents').where('storagePath', '==', path).limit(1).get();
      if (!q.empty) { snapId = q.docs[0].id; data = q.docs[0].data() as DocData; }
    } else {
      return NextResponse.json({ error: 'docId or path required' }, { status: 400 });
    }

    if (!data || !snapId) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const wsId = data.workspaceId;
    const ownerOk = data.ownerId === auth.uid;
    const wsOk = wsId && !isPersonalWorkspaceId(wsId) ? await isWorkspaceMember(wsId, auth.uid) : false;
    if (!(ownerOk || wsOk)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const signedUrl = includeUrl && data.storagePath ? await presignGet(data.storagePath, 60 * 60) : null;

    return NextResponse.json({
      id: snapId,
      name: data.name ?? null,
      type: data.type ?? null,
      workspaceId: data.workspaceId ?? null,
      ownerId: data.ownerId ?? null,
      folder: data.folder ?? null,
      mimeType: data.mimeType ?? null,
      size: data.size ?? null,
      storagePath: data.storagePath ?? null,
      storageBackend: data.storageBackend ?? 'firebase',
      contentHash: data.contentHash ?? null,
      version: data.version ?? null,
      syncState: data.syncState ?? null,
      updatedAt: tsString(data.updatedAt),
      signedUrl
    });
  } catch (e) {
    console.error('[sync/manifest] error:', getErrorMessage(e));
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
