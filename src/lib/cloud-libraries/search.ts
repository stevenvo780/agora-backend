import type { LibraryListFilter, STLibrary } from './types';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const normalizeLimit = (raw: number | undefined): number => {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  const n = Math.floor(raw);
  if (n <= 0) return DEFAULT_LIMIT;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
};

export const matchesProfileFilter = (library: Pick<STLibrary, 'claims'>, profile: string): boolean =>
  library.claims.some((claim) => claim.profile === profile);

export const matchesTagFilter = (library: Pick<STLibrary, 'claims'>, tag: string): boolean =>
  library.claims.some((claim) => Array.isArray(claim.tags) && claim.tags.includes(tag));

export const applyLibraryFilters = (libraries: STLibrary[], filter: LibraryListFilter): STLibrary[] => {
  let out = libraries;
  if (filter.ownerUid) {
    out = out.filter((lib) => lib.owner.uid === filter.ownerUid);
  }
  if (filter.visibility) {
    out = out.filter((lib) => lib.visibility === filter.visibility);
  }
  if (filter.profile) {
    const profile = filter.profile;
    out = out.filter((lib) => matchesProfileFilter(lib, profile));
  }
  if (filter.tag) {
    const tag = filter.tag;
    out = out.filter((lib) => matchesTagFilter(lib, tag));
  }
  const limit = normalizeLimit(filter.limit);
  return out.slice(0, limit);
};

export const LIBRARY_SEARCH_LIMITS = Object.freeze({ DEFAULT_LIMIT, MAX_LIMIT });
