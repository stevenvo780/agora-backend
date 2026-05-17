import { adminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { applyLibraryFilters, normalizeLimit } from './search';
import type {
  LibraryListFilter,
  LibraryRequester,
  STLibrary,
  STLibraryCreateInput,
  STLibraryUpdatePatch
} from './types';
import { canMutateLibrary, canReadLibrary } from './visibility';

const COLLECTION = 'stLibraries';

const documentToLibrary = (id: string, data: Record<string, unknown>): STLibrary => ({
  id,
  name: typeof data.name === 'string' ? data.name : '',
  description: typeof data.description === 'string' ? data.description : '',
  owner: (data.owner && typeof data.owner === 'object'
    ? data.owner
    : { uid: '' }) as STLibrary['owner'],
  visibility: (data.visibility as STLibrary['visibility']) ?? 'private',
  claims: Array.isArray(data.claims) ? (data.claims as STLibrary['claims']) : [],
  consumers: Array.isArray(data.consumers) ? (data.consumers as string[]) : [],
  createdAt: typeof data.createdAt === 'string' ? data.createdAt : '',
  updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '',
  version: typeof data.version === 'string' ? data.version : '0.0.0'
});

export async function createLibrary(input: STLibraryCreateInput): Promise<STLibrary> {
  const now = new Date().toISOString();
  const ownerData: STLibrary['owner'] = { uid: input.owner.uid };
  if (input.owner.workspaceId) ownerData.workspaceId = input.owner.workspaceId;

  const data: Omit<STLibrary, 'id'> = {
    name: input.name,
    description: input.description,
    owner: ownerData,
    visibility: input.visibility,
    claims: input.claims,
    consumers: [],
    createdAt: now,
    updatedAt: now,
    version: input.version
  };
  const ref = await adminDb.collection(COLLECTION).add(data);
  return { id: ref.id, ...data };
}

export async function getLibrary(id: string, requester: LibraryRequester): Promise<STLibrary | null> {
  const snap = await adminDb.collection(COLLECTION).doc(id).get();
  if (!snap.exists) return null;
  const lib = documentToLibrary(snap.id, snap.data() ?? {});
  if (!canReadLibrary(lib, requester)) return null;
  return lib;
}

export async function updateLibrary(
  id: string,
  patch: STLibraryUpdatePatch,
  requester: Pick<LibraryRequester, 'uid'>
): Promise<STLibrary> {
  const ref = adminDb.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new LibraryError('not-found', 'Library not found');
  const current = documentToLibrary(snap.id, snap.data() ?? {});
  if (!canMutateLibrary(current, requester)) throw new LibraryError('forbidden', 'Forbidden');

  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.description !== undefined) updates.description = patch.description;
  if (patch.visibility !== undefined) updates.visibility = patch.visibility;
  if (patch.claims !== undefined) updates.claims = patch.claims;
  if (patch.version !== undefined) updates.version = patch.version;

  await ref.update(updates);
  const refreshed = await ref.get();
  return documentToLibrary(refreshed.id, refreshed.data() ?? {});
}

export async function deleteLibrary(id: string, requester: Pick<LibraryRequester, 'uid'>): Promise<boolean> {
  const ref = adminDb.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return false;
  const current = documentToLibrary(snap.id, snap.data() ?? {});
  if (!canMutateLibrary(current, requester)) throw new LibraryError('forbidden', 'Forbidden');
  await ref.delete();
  return true;
}

export async function listLibraries(filter: LibraryListFilter): Promise<STLibrary[]> {
  const limit = normalizeLimit(filter.limit);

  let query: FirebaseFirestore.Query = adminDb.collection(COLLECTION);
  if (filter.ownerUid) {
    query = query.where('owner.uid', '==', filter.ownerUid);
  }
  if (filter.visibility) {
    query = query.where('visibility', '==', filter.visibility);
  }

  const snap = await query.limit(Math.min(limit * 4, 1000)).get();
  const libraries = snap.docs.map((doc) => documentToLibrary(doc.id, doc.data() ?? {}));
  return applyLibraryFilters(libraries, filter);
}

export async function subscribeLibrary(
  libraryId: string,
  workspaceId: string,
  requester: LibraryRequester
): Promise<void> {
  if (!workspaceId) throw new LibraryError('invalid', 'workspaceId requerido');
  const ref = adminDb.collection('stLibraries').doc(libraryId);
  const snap = await ref.get();
  if (!snap.exists) throw new LibraryError('not-found', 'Library not found');
  const lib = documentToLibrary(snap.id, snap.data() ?? {});
  if (!canReadLibrary(lib, requester)) throw new LibraryError('forbidden', 'Forbidden');

  await ref.update({
    consumers: FieldValue.arrayUnion(workspaceId),
    updatedAt: new Date().toISOString()
  });
}

export type LibraryErrorCode = 'not-found' | 'forbidden' | 'invalid';

export class LibraryError extends Error {
  public readonly code: LibraryErrorCode;
  constructor(code: LibraryErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'LibraryError';
  }
}

export const isLibraryError = (value: unknown): value is LibraryError =>
  value instanceof LibraryError;
