import type { LibraryRequester, LibraryVisibility, STLibrary } from './types';

export const isLibraryOwner = (library: Pick<STLibrary, 'owner'>, requester: Pick<LibraryRequester, 'uid'>): boolean =>
  library.owner.uid === requester.uid;

const isWorkspaceMatch = (libraryWorkspaceId: string | undefined, requesterWorkspaceId: string | undefined): boolean => {
  if (!libraryWorkspaceId) return false;
  if (!requesterWorkspaceId) return false;
  return libraryWorkspaceId === requesterWorkspaceId;
};

export const canReadLibrary = (
  library: Pick<STLibrary, 'owner' | 'visibility' | 'consumers'>,
  requester: LibraryRequester
): boolean => {
  if (isLibraryOwner(library, requester)) return true;
  if (library.visibility === 'public') return true;
  if (library.visibility === 'workspace') {
    if (isWorkspaceMatch(library.owner.workspaceId, requester.workspaceId)) return true;
    if (requester.workspaceId && library.consumers.includes(requester.workspaceId)) return true;
  }
  return false;
};

export const canMutateLibrary = (
  library: Pick<STLibrary, 'owner'>,
  requester: Pick<LibraryRequester, 'uid'>
): boolean => isLibraryOwner(library, requester);

export const filterReadableLibraries = <T extends Pick<STLibrary, 'owner' | 'visibility' | 'consumers'>>(
  libraries: T[],
  requester: LibraryRequester
): T[] => libraries.filter((lib) => canReadLibrary(lib, requester));

export const visibilityIsRestricted = (visibility: LibraryVisibility): boolean =>
  visibility === 'private' || visibility === 'workspace';
