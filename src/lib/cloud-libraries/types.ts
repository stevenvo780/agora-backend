export type LibraryVisibility = 'public' | 'private' | 'workspace';

export type LibraryClaimKind = 'axiom' | 'theorem';

export interface LibraryClaim {
  id: string;
  formula: string;
  profile: string;
  kind: LibraryClaimKind;
  tags?: string[];
}

export interface LibraryOwner {
  uid: string;
  workspaceId?: string;
}

export interface STLibrary {
  id: string;
  name: string;
  description: string;
  owner: LibraryOwner;
  visibility: LibraryVisibility;
  claims: LibraryClaim[];
  consumers: string[];
  createdAt: string;
  updatedAt: string;
  version: string;
}

export type STLibraryCreateInput = Omit<STLibrary, 'id' | 'consumers' | 'createdAt' | 'updatedAt'>;

export type STLibraryUpdatePatch = Partial<
  Pick<STLibrary, 'name' | 'description' | 'visibility' | 'claims' | 'version'>
>;

export interface LibraryRequester {
  uid: string;
  workspaceId?: string;
}

export interface LibraryListFilter {
  ownerUid?: string;
  visibility?: LibraryVisibility;
  profile?: string;
  tag?: string;
  limit?: number;
}

export const LIBRARY_VISIBILITIES: ReadonlyArray<LibraryVisibility> = ['public', 'private', 'workspace'];

export const LIBRARY_CLAIM_KINDS: ReadonlyArray<LibraryClaimKind> = ['axiom', 'theorem'];

export const isLibraryVisibility = (value: unknown): value is LibraryVisibility =>
  typeof value === 'string' && (LIBRARY_VISIBILITIES as ReadonlyArray<string>).includes(value);

export const isLibraryClaimKind = (value: unknown): value is LibraryClaimKind =>
  typeof value === 'string' && (LIBRARY_CLAIM_KINDS as ReadonlyArray<string>).includes(value);
