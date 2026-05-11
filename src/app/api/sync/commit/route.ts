/**
 * /api/sync/commit
 *
 * Cliente declara: "ya subí este blob al NAS, registra la nueva versión".
 * Body: { docId, contentHash, size, baseVersion?, name?, folder?, type?, mimeType? }
 * Server: valida ACL, hace bump de version (con conflict detection vs baseVersion), emite ping RTDB.
 *
 * Metadata vive en Firestore. Bumpeamos `version` y registramos `contentHash`/`syncState`.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth, isWorkspaceMember } from '@/lib/server-auth';

export const runtime = 'nodejs';
import { isPersonalWorkspaceId } from '@/types/workspace';
import { adminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { objectExists } from '@/lib/nas-storage';
import { emitPing } from '@/lib/nas-events';
import { getErrorMessage } from '@/lib/error-utils';

interface DocData {
  workspaceId?: string;
  ownerId?: string;
  storagePath?: string;
  contentHash?: string;
  version?: number;
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

    const body = await req.json();
    const docId: string | undefined = typeof body.docId === 'string' ? body.docId : undefined;
    const contentHash: string | undefined = typeof body.contentHash === 'string' ? body.contentHash : undefined;
    const size: number | undefined = typeof body.size === 'number' ? body.size : undefined;
    const baseVersion: number | undefined = typeof body.baseVersion === 'number' ? body.baseVersion : undefined;

    if (!docId || !contentHash) {
      return NextResponse.json({ error: 'docId and contentHash required' }, { status: 400 });
    }

    const ref = adminDb.collection('documents').doc(docId);
    const snap = await ref.get();
    if (!snap.exists) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const data = snap.data() as DocData;

    const wsId = data.workspaceId;
    const ownerOk = data.ownerId === auth.uid;
    const wsOk = wsId && !isPersonalWorkspaceId(wsId) ? await isWorkspaceMember(wsId, auth.uid) : false;
    if (!(ownerOk || wsOk)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    if (!data.storagePath) return NextResponse.json({ error: 'No storagePath on doc' }, { status: 409 });
    if (!(await objectExists(data.storagePath))) {
      return NextResponse.json({ error: 'Object not present in NAS bucket' }, { status: 412 });
    }

    type CommitConflict = { kind: 'conflict'; currentVersion: number; currentHash: string | null };
    type CommitSuccess = { kind: 'ok'; newVersion: number; baseVersion: number };
    let txResult: CommitConflict | CommitSuccess;
    try {
      txResult = await adminDb.runTransaction<CommitConflict | CommitSuccess>(async (tx) => {
        const inTxSnap = await tx.get(ref);
        if (!inTxSnap.exists) {
          throw new Error('Not found');
        }
        const inTxData = inTxSnap.data() as DocData;
        const currentVersion = typeof inTxData.version === 'number' ? inTxData.version : 0;
        if (typeof baseVersion === 'number' && baseVersion < currentVersion) {
          return { kind: 'conflict', currentVersion, currentHash: inTxData.contentHash ?? null };
        }
        const newVersion = currentVersion + 1;
        const update: Record<string, unknown> = {
          contentHash,
          version: newVersion,
          baseVersion: currentVersion,
          syncState: 'synced',
          lastWriter: auth.uid,
          storageBackend: 'minio',
          updatedAt: FieldValue.serverTimestamp()
        };
        if (typeof size === 'number') update.size = size;
        tx.update(ref, update);
        return { kind: 'ok', newVersion, baseVersion: currentVersion };
      });
    } catch (txError) {
      if (txError instanceof Error && txError.message === 'Not found') {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      throw txError;
    }

    if (txResult.kind === 'conflict') {
      return NextResponse.json({
        error: 'conflict',
        currentVersion: txResult.currentVersion,
        currentHash: txResult.currentHash
      }, { status: 409 });
    }

    const newVersion = txResult.newVersion;
    const ping = await emitPing({
      scope: 'document',
      workspaceId: wsId ?? null,
      userId: data.ownerId ?? null,
      docId,
      path: data.storagePath,
      version: newVersion,
      contentHash,
      sender: auth.uid
    });

    return NextResponse.json({
      ok: true,
      version: newVersion,
      contentHash,
      outboxId: ping.outboxId,
      rtdbPath: ping.rtdbPath
    });
  } catch (e) {
    console.error('[sync/commit] error:', getErrorMessage(e));
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
