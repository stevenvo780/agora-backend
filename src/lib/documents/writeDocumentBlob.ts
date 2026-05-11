import { FieldValue, type DocumentReference, type WriteResult } from 'firebase-admin/firestore';
import { putObject, deleteObject } from '@/lib/nas-storage';
import { computeSearchableContent } from '@/lib/search/searchable-content';
import { emitPing, type SyncPing } from '@/lib/nas-events';
import { invalidateAgoraWorkspaceContext } from '@/lib/agora-ai/context';
import { getErrorMessage } from '@/lib/error-utils';
import { parseAndPersistCitationsForDoc } from '@/lib/citations/workspace-citations';

export type WriteDocumentBlobSource =
  | 'api-create'
  | 'api-update'
  | 'agent-create'
  | 'agent-update'
  | 'agent-restore'
  | 'convert-md'
  | 'upload-md'
  | 'worker-commit';

export interface WriteDocumentBlobInput {
  docRef: DocumentReference;
  content: string;
  workspaceId: string;
  ownerId: string;
  storagePath: string;
  contentType?: string;
  source: WriteDocumentBlobSource;
  writerId: string;
  baseVersion?: number;
  extraUpdate?: Record<string, unknown>;
  emitPingPayload?: Partial<SyncPing>;
  skipPing?: boolean;
}

export interface WriteDocumentBlobResult {
  size: number;
  contentHash: string;
  searchableContent: string | null;
  version: number;
  writeResult: WriteResult;
}

const buildSearchableField = (content: string): string | FirebaseFirestore.FieldValue => {
  const computed = computeSearchableContent(content);
  return computed.length > 0 ? computed : FieldValue.delete();
};

export async function writeDocumentBlob(input: WriteDocumentBlobInput): Promise<WriteDocumentBlobResult> {
  const baseVersion = typeof input.baseVersion === 'number' ? input.baseVersion : 0;
  const nextVersion = baseVersion + 1;
  const contentType = input.contentType ?? 'text/markdown';

  const put = await putObject(input.storagePath, input.content, {
    contentType,
    metadata: {
      'agora-source': input.source,
      'agora-writer': input.writerId,
      'agora-owner': input.ownerId
    }
  });

  const updatePayload: Record<string, unknown> = {
    storagePath: input.storagePath,
    storageBackend: 'minio',
    contentHash: put.contentHash,
    size: put.size,
    version: nextVersion,
    baseVersion,
    syncState: 'synced',
    lastWriter: input.writerId,
    searchableContent: buildSearchableField(input.content),
    content: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
    ...(input.extraUpdate ?? {})
  };

  let writeResult: WriteResult;
  try {
    writeResult = await input.docRef.update(updatePayload);
  } catch (err) {
    await deleteObject(input.storagePath).catch((cleanupErr) => {
      console.warn('[writeDocumentBlob] rollback delete failed:', getErrorMessage(cleanupErr));
    });
    throw err;
  }

  invalidateAgoraWorkspaceContext(input.workspaceId);

  if (!input.skipPing) {
    await emitPing({
      scope: 'document',
      workspaceId: input.workspaceId,
      docId: input.docRef.id,
      path: input.storagePath,
      version: nextVersion,
      contentHash: put.contentHash,
      sender: input.writerId,
      ...(input.emitPingPayload ?? {})
    }).catch((err) => {
      console.warn('[writeDocumentBlob] emitPing failed:', getErrorMessage(err));
    });
  }

  void parseAndPersistCitationsForDoc({
    docId: input.docRef.id,
    workspaceId: input.workspaceId,
    uid: input.ownerId,
    content: input.content
  }).catch((err) => {
    console.warn('[writeDocumentBlob] citations parse failed:', getErrorMessage(err));
  });

  const computed = computeSearchableContent(input.content);
  return {
    size: put.size,
    contentHash: put.contentHash,
    searchableContent: computed.length > 0 ? computed : null,
    version: nextVersion,
    writeResult
  };
}

export interface CreateDocumentBlobInput {
  docRef: DocumentReference;
  content: string;
  workspaceId: string;
  ownerId: string;
  storagePath: string;
  contentType?: string;
  source: WriteDocumentBlobSource;
  writerId: string;
  initialDocData: Record<string, unknown>;
  skipPing?: boolean;
  emitPingPayload?: Partial<SyncPing>;
}

export async function createDocumentBlob(input: CreateDocumentBlobInput): Promise<WriteDocumentBlobResult> {
  const contentType = input.contentType ?? 'text/markdown';

  const put = await putObject(input.storagePath, input.content, {
    contentType,
    metadata: {
      'agora-source': input.source,
      'agora-writer': input.writerId,
      'agora-owner': input.ownerId
    }
  });

  const computedSearchable = computeSearchableContent(input.content);
  const docData: Record<string, unknown> = {
    ...input.initialDocData,
    storagePath: input.storagePath,
    storageBackend: 'minio',
    contentHash: put.contentHash,
    size: put.size,
    version: 1,
    baseVersion: 0,
    syncState: 'synced',
    lastWriter: input.writerId
  };
  if (computedSearchable.length > 0) {
    docData.searchableContent = computedSearchable;
  }

  let writeResult: WriteResult;
  try {
    writeResult = await input.docRef.set(docData);
  } catch (err) {
    await deleteObject(input.storagePath).catch((cleanupErr) => {
      console.warn('[createDocumentBlob] rollback delete failed:', getErrorMessage(cleanupErr));
    });
    throw err;
  }

  invalidateAgoraWorkspaceContext(input.workspaceId);

  if (!input.skipPing) {
    await emitPing({
      scope: 'document',
      workspaceId: input.workspaceId,
      docId: input.docRef.id,
      path: input.storagePath,
      version: 1,
      contentHash: put.contentHash,
      sender: input.writerId,
      ...(input.emitPingPayload ?? {})
    }).catch((err) => {
      console.warn('[createDocumentBlob] emitPing failed:', getErrorMessage(err));
    });
  }

  void parseAndPersistCitationsForDoc({
    docId: input.docRef.id,
    workspaceId: input.workspaceId,
    uid: input.ownerId,
    content: input.content
  }).catch((err) => {
    console.warn('[createDocumentBlob] citations parse failed:', getErrorMessage(err));
  });

  return {
    size: put.size,
    contentHash: put.contentHash,
    searchableContent: computedSearchable.length > 0 ? computedSearchable : null,
    version: 1,
    writeResult
  };
}
