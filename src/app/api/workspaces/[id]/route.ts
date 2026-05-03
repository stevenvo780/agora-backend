import { adminDb } from '@/lib/firebase-admin';
import { presignGet, putObject, getObjectBuffer, copyObject, getNasClient, getNasBucket } from '@/lib/nas-storage';
import { ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { FieldValue, type CollectionReference, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { getErrorMessage } from '@/lib/error-utils';
import { isAdminUser, requireAuth, invalidateMembershipCache } from '@/lib/server-auth';
import { WorkspaceType } from '@/types/workspace';
import { syncWorkspaceClaims } from '@/lib/workspace-claims';
import { DEFAULT_FOLDER_NAME, normalizeFolderPath } from '@/lib/folder-utils';
import { buildStoragePath, ensureTextFileName, sanitizeFileName } from '@/lib/storage-path';
import { DocumentType } from '@/types/documents';
import { invalidateStorageUsageCache } from '@/lib/storage-usage';
import { deleteForgejoRepo, isForgejoConfigured } from '@/lib/forgejo';
import { emitPing } from '@/lib/nas-events';

const deleteCollectionInBatches = async (collectionRef: CollectionReference, batchLimit = 400) => {
  let lastDoc: QueryDocumentSnapshot | null = null;

  while (true) {
    let query = collectionRef.orderBy('__name__').limit(batchLimit);
    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();
    if (snapshot.empty) break;

    const batch = adminDb.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    if (snapshot.size < batchLimit) break;
    lastDoc = snapshot.docs[snapshot.docs.length - 1];
  }
};

const deleteBoardData = async (workspaceId: string) => {
  const boardRef = adminDb.collection('boards').doc(workspaceId);
  const snap = await boardRef.get();
  if (!snap.exists) return false;

  // Delete columns and cards in parallel — they are independent
  await Promise.all([
    deleteCollectionInBatches(boardRef.collection('columns')),
    deleteCollectionInBatches(boardRef.collection('cards'))
  ]);
  await boardRef.delete();
  return true;
};

type WorkspaceRecord = {
  ownerId?: string;
  type?: string;
  name?: string;
  members?: string[];
  pendingInvites?: string[];
};

type StoredDocumentRecord = Record<string, unknown>;
type StoredWorkspaceDocument = { id: string } & StoredDocumentRecord;

const canManageWorkspace = async (workspace: WorkspaceRecord | undefined, uid: string) => {
  if (!workspace || workspace.type === WorkspaceType.Personal) return false;
  if (workspace.ownerId === uid) return true;
  return isAdminUser(uid);
};

const ensureBoardExists = async (workspaceId: string) => {
  const boardRef = adminDb.collection('boards').doc(workspaceId);
  const snap = await boardRef.get();
  if (!snap.exists) {
    await boardRef.set({
      workspaceId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
  }
  return boardRef;
};

const createSignedReadUrl = async (storagePath: string) => {
  try {
    return await presignGet(storagePath, 60 * 60);
  } catch {
    return undefined;
  }
};

const cloneStorageObject = async (params: {
  sourcePath: string;
  targetWorkspaceId: string;
  ownerId: string;
  folder: string;
  fileName: string;
}) => {
  const targetPath = buildStoragePath({
    workspaceId: params.targetWorkspaceId,
    ownerId: params.ownerId,
    folder: params.folder,
    fileName: params.fileName
  });

  try {
    if (targetPath !== params.sourcePath) {
      await copyObject(params.sourcePath, targetPath);
    }
    const buf = await getObjectBuffer(targetPath);
    if (!buf) return null;
    return {
      storagePath: targetPath,
      size: buf.length,
      url: await createSignedReadUrl(targetPath)
    };
  } catch {
    return null;
  }
};

const resolveFolderRecordPath = (doc: StoredDocumentRecord) => {
  const parentPath = normalizeFolderPath(typeof doc.folder === 'string' ? doc.folder : undefined);
  const name = typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim() : 'Carpeta';
  return parentPath === DEFAULT_FOLDER_NAME ? name : `${parentPath}/${name}`;
};

const resolveMergedDocName = (params: {
  doc: StoredDocumentRecord;
  targetDocs: StoredDocumentRecord[];
}) => {
  const baseName = typeof params.doc.name === 'string' && params.doc.name.trim()
    ? params.doc.name.trim()
    : 'Sin titulo';
  const folder = normalizeFolderPath(typeof params.doc.folder === 'string' ? params.doc.folder : undefined);
  const type = typeof params.doc.type === 'string' ? params.doc.type : DocumentType.Text;

  const matches = (name: string) => params.targetDocs.some(existing => (
    normalizeFolderPath(typeof existing.folder === 'string' ? existing.folder : undefined) === folder
    && (typeof existing.type === 'string' ? existing.type : DocumentType.Text) === type
    && String(existing.name || '').trim().toLowerCase() === name.trim().toLowerCase()
  ));

  if (!matches(baseName)) return baseName;

  let suffix = 2;
  let candidate = `${baseName} (copia)`;
  while (matches(candidate)) {
    candidate = `${baseName} (copia ${suffix})`;
    suffix += 1;
  }
  return candidate;
};

const cloneTextDocumentToWorkspace = async (params: {
  doc: StoredDocumentRecord;
  targetWorkspaceId: string;
  ownerId: string;
  targetName: string;
}) => {
  const folder = normalizeFolderPath(typeof params.doc.folder === 'string' ? params.doc.folder : undefined);
  const mimeType = typeof params.doc.mimeType === 'string' && params.doc.mimeType
    ? params.doc.mimeType
    : 'text/markdown';
  const content = typeof params.doc.content === 'string' ? params.doc.content : '';
  const storageFileName = ensureTextFileName(params.targetName);
  const clonedStorage = typeof params.doc.storagePath === 'string'
    ? await cloneStorageObject({
      sourcePath: params.doc.storagePath,
      targetWorkspaceId: params.targetWorkspaceId,
      ownerId: params.ownerId,
      folder,
      fileName: storageFileName
    })
    : null;

  if (!clonedStorage && content) {
    const targetPath = buildStoragePath({
      workspaceId: params.targetWorkspaceId,
      ownerId: params.ownerId,
      folder,
      fileName: storageFileName
    });
    await putObject(targetPath, content, {
      contentType: mimeType,
      metadata: { 'agora-source': 'workspace-clone', 'agora-owner': params.ownerId }
    });
    return {
      storagePath: targetPath,
      url: await createSignedReadUrl(targetPath)
    };
  }

  return clonedStorage;
};

const cloneFileDocumentToWorkspace = async (params: {
  doc: StoredDocumentRecord;
  targetWorkspaceId: string;
  ownerId: string;
  targetName: string;
}) => {
  const folder = normalizeFolderPath(typeof params.doc.folder === 'string' ? params.doc.folder : undefined);
  const sourcePath = typeof params.doc.storagePath === 'string' ? params.doc.storagePath : null;
  if (!sourcePath) {
    return {
      storagePath: typeof params.doc.storagePath === 'string' ? params.doc.storagePath : undefined,
      url: typeof params.doc.url === 'string' ? params.doc.url : undefined,
      size: typeof params.doc.size === 'number' ? params.doc.size : undefined
    };
  }

  const cloned = await cloneStorageObject({
    sourcePath,
    targetWorkspaceId: params.targetWorkspaceId,
    ownerId: params.ownerId,
    folder,
    fileName: sanitizeFileName(params.targetName)
  });

  if (cloned) {
    return cloned;
  }

  return {
    storagePath: sourcePath,
    url: await createSignedReadUrl(sourcePath),
    size: typeof params.doc.size === 'number' ? params.doc.size : undefined
  };
};

const cloneWorkspaceDocuments = async (params: {
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
  ownerId: string;
  mergeIntoExisting: boolean;
}) => {
  const sourceSnapshot = await adminDb
    .collection('documents')
    .where('workspaceId', '==', params.sourceWorkspaceId)
    .get();

  const targetSnapshot = await adminDb
    .collection('documents')
    .where('workspaceId', '==', params.targetWorkspaceId)
    .get();

  const targetDocs = targetSnapshot.docs.map(doc => ({
    id: doc.id,
    ...(doc.data() as StoredDocumentRecord)
  })) as StoredWorkspaceDocument[];
  let created = 0;
  let skippedFolders = 0;
  let clonedFiles = 0;

  const sourceDocs = sourceSnapshot.docs.map(doc => ({
    id: doc.id,
    ...(doc.data() as StoredDocumentRecord)
  })) as StoredWorkspaceDocument[];

  sourceDocs
    .sort((a, b) => {
      const isFolderA = a.type === DocumentType.Folder;
      const isFolderB = b.type === DocumentType.Folder;
      if (isFolderA !== isFolderB) return isFolderA ? -1 : 1;
      const folderA = normalizeFolderPath(typeof a.folder === 'string' ? a.folder : undefined);
      const folderB = normalizeFolderPath(typeof b.folder === 'string' ? b.folder : undefined);
      if (folderA !== folderB) return folderA.localeCompare(folderB);
      return String(a.name || '').localeCompare(String(b.name || ''));
    });

  for (const sourceDoc of sourceDocs) {
    const sourceType = typeof sourceDoc.type === 'string' ? sourceDoc.type : DocumentType.Text;
    const folder = normalizeFolderPath(typeof sourceDoc.folder === 'string' ? sourceDoc.folder : undefined);
    let targetName = typeof sourceDoc.name === 'string' && sourceDoc.name.trim()
      ? sourceDoc.name.trim()
      : 'Sin titulo';

    if (params.mergeIntoExisting && sourceType === DocumentType.Folder) {
      const sourcePath = resolveFolderRecordPath(sourceDoc);
      const existingFolderDoc = targetDocs.find(existing => (
        (typeof existing.type === 'string' ? existing.type : DocumentType.Text) === DocumentType.Folder
        && resolveFolderRecordPath(existing) === sourcePath
      ));
      if (existingFolderDoc) {
        skippedFolders += 1;
        continue;
      }
    }

    if (params.mergeIntoExisting && sourceType !== DocumentType.Folder) {
      targetName = resolveMergedDocName({ doc: sourceDoc, targetDocs });
    }

    const cloneData: StoredDocumentRecord = {
      name: targetName,
      type: sourceType,
      ownerId: params.ownerId,
      workspaceId: params.targetWorkspaceId,
      folder,
      mimeType: typeof sourceDoc.mimeType === 'string' ? sourceDoc.mimeType : null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };
    if (typeof sourceDoc.order === 'number') {
      cloneData.order = sourceDoc.order;
    }

    if (typeof sourceDoc.sourceName === 'string') cloneData.sourceName = sourceDoc.sourceName;
    if (typeof sourceDoc.sourceMimeType === 'string') cloneData.sourceMimeType = sourceDoc.sourceMimeType;
    if (typeof sourceDoc.sourceStoragePath === 'string') cloneData.sourceStoragePath = sourceDoc.sourceStoragePath;
    if (typeof sourceDoc.sourceUrl === 'string') cloneData.sourceUrl = sourceDoc.sourceUrl;
    if (typeof sourceDoc.sourceFormat === 'string') cloneData.sourceFormat = sourceDoc.sourceFormat;

    if (sourceType === DocumentType.File) {
      const fileClone = await cloneFileDocumentToWorkspace({
        doc: sourceDoc,
        targetWorkspaceId: params.targetWorkspaceId,
        ownerId: params.ownerId,
        targetName
      });
      if (fileClone.storagePath) cloneData.storagePath = fileClone.storagePath;
      if (fileClone.url) cloneData.url = fileClone.url;
      if (typeof fileClone.size === 'number') cloneData.size = fileClone.size;
      clonedFiles += 1;
    } else if (sourceType !== DocumentType.Folder) {
      cloneData.content = typeof sourceDoc.content === 'string' ? sourceDoc.content : '';
      const textClone = await cloneTextDocumentToWorkspace({
        doc: sourceDoc,
        targetWorkspaceId: params.targetWorkspaceId,
        ownerId: params.ownerId,
        targetName
      });
      if (textClone?.storagePath) cloneData.storagePath = textClone.storagePath;
      if (textClone?.url) cloneData.url = textClone.url;
    }

    const createdRef = await adminDb.collection('documents').add(cloneData);
    targetDocs.push({ id: createdRef.id, ...cloneData });
    created += 1;
  }

  return { created, skippedFolders, clonedFiles };
};

const cloneBoardDataToWorkspace = async (params: {
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
  mergeIntoExisting: boolean;
}) => {
  const sourceBoardRef = adminDb.collection('boards').doc(params.sourceWorkspaceId);
  const sourceBoardSnap = await sourceBoardRef.get();
  if (!sourceBoardSnap.exists) {
    return { columnsCreated: 0, cardsCreated: 0 };
  }

  const targetBoardRef = await ensureBoardExists(params.targetWorkspaceId);
  const sourceColumnsSnap = await sourceBoardRef.collection('columns').orderBy('order').get();
  const sourceCardsSnap = await sourceBoardRef.collection('cards').orderBy('order').get();

  if (!params.mergeIntoExisting) {
    await Promise.all([
      deleteCollectionInBatches(targetBoardRef.collection('columns')),
      deleteCollectionInBatches(targetBoardRef.collection('cards'))
    ]);

    const columnIdMap = new Map<string, string>();
    for (const sourceColumn of sourceColumnsSnap.docs) {
      const targetColumnRef = targetBoardRef.collection('columns').doc();
      columnIdMap.set(sourceColumn.id, targetColumnRef.id);
      await targetColumnRef.set({
        ...sourceColumn.data(),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
    }

    for (const sourceCard of sourceCardsSnap.docs) {
      const data = sourceCard.data();
      await targetBoardRef.collection('cards').doc().set({
        ...data,
        columnId: columnIdMap.get(String(data.columnId || '')) || data.columnId,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
    }

    return {
      columnsCreated: sourceColumnsSnap.size,
      cardsCreated: sourceCardsSnap.size
    };
  }

  const targetColumnsSnap = await targetBoardRef.collection('columns').orderBy('order').get();
  const targetCardsSnap = await targetBoardRef.collection('cards').orderBy('order').get();
  const targetColumnByName = new Map<string, { id: string; order: number }>();
  let maxColumnOrder = 0;

  targetColumnsSnap.docs.forEach(doc => {
    const data = doc.data();
    const name = typeof data.name === 'string' ? data.name.trim().toLowerCase() : '';
    const order = typeof data.order === 'number' ? data.order : 0;
    maxColumnOrder = Math.max(maxColumnOrder, order);
    if (name) {
      targetColumnByName.set(name, { id: doc.id, order });
    }
  });

  const columnIdMap = new Map<string, string>();
  let columnsCreated = 0;

  for (const sourceColumn of sourceColumnsSnap.docs) {
    const data = sourceColumn.data();
    const normalizedName = typeof data.name === 'string' ? data.name.trim().toLowerCase() : '';
    const existing = normalizedName ? targetColumnByName.get(normalizedName) : null;
    if (existing) {
      columnIdMap.set(sourceColumn.id, existing.id);
      continue;
    }

    maxColumnOrder += 1000;
    const targetColumnRef = targetBoardRef.collection('columns').doc();
    await targetColumnRef.set({
      name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : 'Sin titulo',
      order: maxColumnOrder,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    columnIdMap.set(sourceColumn.id, targetColumnRef.id);
    columnsCreated += 1;
  }

  const maxOrderByColumn = new Map<string, number>();
  targetCardsSnap.docs.forEach(doc => {
    const data = doc.data();
    const columnId = typeof data.columnId === 'string' ? data.columnId : '';
    const order = typeof data.order === 'number' ? data.order : 0;
    if (!columnId) return;
    maxOrderByColumn.set(columnId, Math.max(maxOrderByColumn.get(columnId) ?? 0, order));
  });

  let cardsCreated = 0;
  for (const sourceCard of sourceCardsSnap.docs) {
    const data = sourceCard.data();
    const sourceColumnId = typeof data.columnId === 'string' ? data.columnId : '';
    const targetColumnId = columnIdMap.get(sourceColumnId) || sourceColumnId;
    const nextOrder = (maxOrderByColumn.get(targetColumnId) ?? 0) + 1000;
    maxOrderByColumn.set(targetColumnId, nextOrder);
    await targetBoardRef.collection('cards').doc().set({
      ...data,
      columnId: targetColumnId,
      order: nextOrder,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    cardsCreated += 1;
  }

  return { columnsCreated, cardsCreated };
};

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, context: RouteContext) {
  try {
    const auth = await requireAuth(req);
    if (!auth) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const { id } = await context.params;
    const body = await req.json();
    const { action, email } = body;

    if (!id) {
      return NextResponse.json({ error: 'workspace id is required' }, { status: 400 });
    }

    const wsRef = adminDb.collection('workspaces').doc(id);
    const snap = await wsRef.get();
    if (!snap.exists) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    const wsData = snap.data() as WorkspaceRecord | undefined;

    if (action === 'rename') {
      const nextName = typeof body.name === 'string' ? body.name.trim() : '';
      if (!nextName) {
        return NextResponse.json({ error: 'name is required' }, { status: 400 });
      }
      const canManage = await canManageWorkspace(wsData, auth.uid);
      if (!canManage) {
        return NextResponse.json({ error: 'Only workspace owner or admin can rename' }, { status: 403 });
      }
      await wsRef.update({
        name: nextName,
        updatedAt: FieldValue.serverTimestamp()
      });
      return NextResponse.json({ status: 'renamed', id, name: nextName });
    }

    if (action === 'duplicate') {
      const nextName = typeof body.name === 'string' ? body.name.trim() : '';
      if (!nextName) {
        return NextResponse.json({ error: 'name is required' }, { status: 400 });
      }
      const canManage = await canManageWorkspace(wsData, auth.uid);
      if (!canManage) {
        return NextResponse.json({ error: 'Only workspace owner or admin can duplicate' }, { status: 403 });
      }

      const targetWorkspaceRef = adminDb.collection('workspaces').doc();
      const targetWorkspaceData = {
        name: nextName,
        ownerId: auth.uid,
        members: [auth.uid],
        pendingInvites: [],
        type: WorkspaceType.Shared,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };

      await targetWorkspaceRef.set(targetWorkspaceData);

      const [docResult, boardResult] = await Promise.all([
        cloneWorkspaceDocuments({
          sourceWorkspaceId: id,
          targetWorkspaceId: targetWorkspaceRef.id,
          ownerId: auth.uid,
          mergeIntoExisting: false
        }),
        cloneBoardDataToWorkspace({
          sourceWorkspaceId: id,
          targetWorkspaceId: targetWorkspaceRef.id,
          mergeIntoExisting: false
        })
      ]);

      syncWorkspaceClaims(auth.uid).catch(() => {});
      if (docResult.clonedFiles > 0) {
        invalidateStorageUsageCache(auth.uid);
      }

      return NextResponse.json({
        status: 'duplicated',
        workspace: {
          id: targetWorkspaceRef.id,
          name: nextName,
          ownerId: auth.uid,
          members: [auth.uid],
          pendingInvites: [],
          type: WorkspaceType.Shared
        },
        documentsCreated: docResult.created,
        boardColumnsCreated: boardResult.columnsCreated,
        boardCardsCreated: boardResult.cardsCreated
      });
    }

    if (action === 'invite') {
      if (!email) {
        return NextResponse.json({ error: 'email is required' }, { status: 400 });
      }
      if (wsData?.ownerId !== auth.uid) {
        return NextResponse.json({ error: 'Only workspace owner can invite' }, { status: 403 });
      }
      const normalizedEmail = email.toLowerCase().trim();
      await wsRef.update({ pendingInvites: FieldValue.arrayUnion(normalizedEmail) });
      invalidateMembershipCache(id);
      return NextResponse.json({ status: 'invited' });
    }

    if (action === 'accept') {
      const normalizedEmail = email?.toLowerCase().trim();
      const normalizedAuthEmail = auth.email?.toLowerCase().trim();
      if (!normalizedEmail || !normalizedAuthEmail || normalizedEmail !== normalizedAuthEmail) {
        return NextResponse.json({ error: 'email mismatch' }, { status: 400 });
      }
      const pending = Array.isArray(wsData?.pendingInvites) ? wsData.pendingInvites.map((e: string) => e.toLowerCase().trim()) : [];
      if (!pending.includes(normalizedEmail)) {
        return NextResponse.json({ error: 'Invite not found' }, { status: 400 });
      }
      await wsRef.update({
        members: FieldValue.arrayUnion(auth.uid),
        pendingInvites: FieldValue.arrayRemove(normalizedEmail)
      });
      invalidateMembershipCache(id);
      // Sync custom claims so security rules work without get()/exists()
      syncWorkspaceClaims(auth.uid).catch(() => {});
      return NextResponse.json({ status: 'accepted' });
    }

    if (action === 'remove_member') {
        const { userId } = body;
        if (!userId) {
            return NextResponse.json({ error: 'userId is required' }, { status: 400 });
        }
        if (wsData?.ownerId !== auth.uid) {
            return NextResponse.json({ error: 'Only workspace owner can remove members' }, { status: 403 });
        }
        if (userId === wsData.ownerId) {
            return NextResponse.json({ error: 'Cannot remove workspace owner' }, { status: 400 });
        }
        await wsRef.update({
            members: FieldValue.arrayRemove(userId)
        });
        invalidateMembershipCache(id);
        // Sync custom claims to revoke workspace access in rules
        syncWorkspaceClaims(userId).catch(() => {});
        return NextResponse.json({ status: 'removed' });
    }

    if (action === 'merge') {
      const sourceWorkspaceId = typeof body.sourceWorkspaceId === 'string' ? body.sourceWorkspaceId.trim() : '';
      if (!sourceWorkspaceId) {
        return NextResponse.json({ error: 'sourceWorkspaceId is required' }, { status: 400 });
      }
      if (sourceWorkspaceId === id) {
        return NextResponse.json({ error: 'Cannot merge a workspace into itself' }, { status: 400 });
      }

      const canManageTarget = await canManageWorkspace(wsData, auth.uid);
      if (!canManageTarget) {
        return NextResponse.json({ error: 'Only workspace owner or admin can receive a merge' }, { status: 403 });
      }

      const sourceRef = adminDb.collection('workspaces').doc(sourceWorkspaceId);
      const sourceSnap = await sourceRef.get();
      if (!sourceSnap.exists) {
        return NextResponse.json({ error: 'Source workspace not found' }, { status: 404 });
      }
      const sourceData = sourceSnap.data() as WorkspaceRecord | undefined;
      const canManageSource = await canManageWorkspace(sourceData, auth.uid);
      if (!canManageSource) {
        return NextResponse.json({ error: 'Only workspace owner or admin can merge this source workspace' }, { status: 403 });
      }

      const [docResult, boardResult] = await Promise.all([
        cloneWorkspaceDocuments({
          sourceWorkspaceId,
          targetWorkspaceId: id,
          ownerId: auth.uid,
          mergeIntoExisting: true
        }),
        cloneBoardDataToWorkspace({
          sourceWorkspaceId,
          targetWorkspaceId: id,
          mergeIntoExisting: true
        })
      ]);

      if (docResult.clonedFiles > 0) {
        invalidateStorageUsageCache(auth.uid);
      }

      // Tras el clone exitoso, dejar el workspace SOURCE listo para borrar:
      // docs Firestore, board, blobs MinIO, repo Forgejo y el doc workspace.
      // Es lo que el usuario espera de "fusionar A en B": A deja de existir.
      const sourceCleanup = { docsDeleted: 0, boardDeleted: false, storageDeleted: false, forgejoDeleted: false };
      const sourceOwnerUid = sourceData?.ownerId ?? auth.uid;
      await Promise.allSettled([
        (async () => {
          const batchLimit = 400;
          let count = 0;
          let lastDoc: QueryDocumentSnapshot | null = null;
          while (true) {
            let q = adminDb.collection('documents').where('workspaceId', '==', sourceWorkspaceId).orderBy('__name__').limit(batchLimit);
            if (lastDoc) q = q.startAfter(lastDoc);
            const snap = await q.get();
            if (snap.empty) break;
            const batch = adminDb.batch();
            snap.docs.forEach(d => batch.delete(d.ref));
            await batch.commit();
            count += snap.size;
            if (snap.size < batchLimit) break;
            lastDoc = snap.docs[snap.docs.length - 1];
          }
          sourceCleanup.docsDeleted = count;
        })().catch((e) => console.warn('[merge] source docs cleanup failed:', getErrorMessage(e))),
        deleteBoardData(sourceWorkspaceId)
          .then(() => { sourceCleanup.boardDeleted = true; })
          .catch((e) => console.warn('[merge] source board cleanup failed:', getErrorMessage(e))),
        (async () => {
          const s3 = getNasClient();
          const bucketName = getNasBucket();
          const prefix = `workspaces/${sourceWorkspaceId}/`;
          let token: string | undefined;
          do {
            const out = await s3.send(new ListObjectsV2Command({
              Bucket: bucketName, Prefix: prefix, ContinuationToken: token
            }));
            const keys = (out.Contents ?? [])
              .map(o => o.Key).filter((k): k is string => typeof k === 'string');
            if (keys.length > 0) {
              await s3.send(new DeleteObjectsCommand({
                Bucket: bucketName, Delete: { Objects: keys.map(Key => ({ Key })) }
              }));
            }
            token = out.IsTruncated ? out.NextContinuationToken : undefined;
          } while (token);
          sourceCleanup.storageDeleted = true;
        })().catch((e) => console.warn('[merge] source storage cleanup failed:', getErrorMessage(e))),
        (async () => {
          if (!isForgejoConfigured()) return;
          const ok = await deleteForgejoRepo({ workspaceId: sourceWorkspaceId, ownerUid: sourceOwnerUid });
          sourceCleanup.forgejoDeleted = ok;
        })().catch((e) => console.warn('[merge] source forgejo cleanup failed:', getErrorMessage(e)))
      ]);
      await sourceRef.delete().catch((e) => console.warn('[merge] source workspace delete failed:', getErrorMessage(e)));

      await wsRef.set({ updatedAt: FieldValue.serverTimestamp() }, { merge: true });

      // Refresca clientes web del workspace target.
      emitPing({
        scope: 'workspace',
        op: 'updated',
        workspaceId: id,
        sender: `merge:${auth.uid}`
      }).catch(() => undefined);

      return NextResponse.json({
        status: 'merged',
        documentsCreated: docResult.created,
        skippedFolders: docResult.skippedFolders,
        boardColumnsCreated: boardResult.columnsCreated,
        boardCardsCreated: boardResult.cardsCreated,
        source: { id: sourceWorkspaceId, ...sourceCleanup }
      });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error: unknown) {
    console.error('Error updating workspace:', getErrorMessage(error));
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  try {
    const auth = await requireAuth(req);
    if (!auth) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: 'workspace id is required' }, { status: 400 });
    }

    const wsRef = adminDb.collection('workspaces').doc(id);
    const snap = await wsRef.get();
    if (!snap.exists) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const data = snap.data() as { ownerId?: string; type?: string } | undefined;
    if (data?.type === WorkspaceType.Personal) {
      return NextResponse.json({ error: 'Personal workspace cannot be deleted' }, { status: 400 });
    }

    const isAdmin = await isAdminUser(auth.uid);
    if (data?.ownerId && auth.uid !== data.ownerId && !isAdmin) {
      return NextResponse.json({ error: 'Only workspace owner or admin can delete' }, { status: 403 });
    }

    // Delete documents, board data, and storage files in parallel
    const [deletedDocs, boardResult, storageResult] = await Promise.allSettled([
      (async () => {
        const batchLimit = 400;
        let count = 0;
        let lastDoc: QueryDocumentSnapshot | null = null;
        while (true) {
          let q = adminDb.collection('documents').where('workspaceId', '==', id).orderBy('__name__').limit(batchLimit);
          if (lastDoc) q = q.startAfter(lastDoc);
          const snap = await q.get();
          if (snap.empty) break;
          const batch = adminDb.batch();
          snap.docs.forEach(d => batch.delete(d.ref));
          await batch.commit();
          count += snap.size;
          if (snap.size < batchLimit) break;
          lastDoc = snap.docs[snap.docs.length - 1];
        }
        return count;
      })(),
      deleteBoardData(id).catch(error => { console.warn('Board cleanup failed for workspace', id, getErrorMessage(error)); return false; }),
      (async () => {
        const s3 = getNasClient();
        const bucketName = getNasBucket();
        const prefix = `workspaces/${id}/`;
        let token: string | undefined;
        do {
          const out = await s3.send(new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: prefix,
            ContinuationToken: token
          }));
          const keys = (out.Contents ?? [])
            .map(o => o.Key)
            .filter((k): k is string => typeof k === 'string');
          if (keys.length > 0) {
            await s3.send(new DeleteObjectsCommand({
              Bucket: bucketName,
              Delete: { Objects: keys.map(Key => ({ Key })) }
            }));
          }
          token = out.IsTruncated ? out.NextContinuationToken : undefined;
        } while (token);
        return true;
      })().catch(error => { console.warn('Storage cleanup failed for workspace', id, getErrorMessage(error)); return false; })
    ]);

    const deletedDocsCount = deletedDocs.status === 'fulfilled' ? deletedDocs.value : 0;
    const boardDeleted = boardResult.status === 'fulfilled' ? boardResult.value : false;
    const storageDeleted = storageResult.status === 'fulfilled' ? storageResult.value : false;

    await wsRef.delete();

    return NextResponse.json({
      status: 'deleted',
      documentsDeleted: deletedDocsCount,
      storageDeleted,
      boardDeleted
    });
  } catch (error: unknown) {
    console.error('Error deleting workspace:', getErrorMessage(error));
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
