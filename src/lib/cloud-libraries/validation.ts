import {
  isLibraryClaimKind,
  isLibraryVisibility,
  type LibraryClaim,
  type LibraryOwner,
  type STLibraryCreateInput,
  type STLibraryUpdatePatch
} from './types';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const MAX_NAME_LEN = 200;
const MAX_DESCRIPTION_LEN = 2000;
const MAX_CLAIMS = 5000;
const MAX_FORMULA_LEN = 8000;
const MAX_TAG_LEN = 64;
const MAX_TAGS_PER_CLAIM = 20;
const MAX_PROFILE_LEN = 64;
const MAX_VERSION_LEN = 32;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+([+-][A-Za-z0-9.-]+)?$/;

const isNonEmptyString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

const parseOwner = (raw: unknown): ParseResult<LibraryOwner> => {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'owner debe ser objeto' };
  const candidate = raw as { uid?: unknown; workspaceId?: unknown };
  if (typeof candidate.uid !== 'string' || candidate.uid.length === 0 || candidate.uid.length > 128) {
    return { ok: false, error: 'owner.uid inválido' };
  }
  if (candidate.workspaceId !== undefined && candidate.workspaceId !== null) {
    if (typeof candidate.workspaceId !== 'string' || candidate.workspaceId.length > 128) {
      return { ok: false, error: 'owner.workspaceId inválido' };
    }
  }
  const owner: LibraryOwner = { uid: candidate.uid };
  if (typeof candidate.workspaceId === 'string' && candidate.workspaceId.length > 0) {
    owner.workspaceId = candidate.workspaceId;
  }
  return { ok: true, value: owner };
};

const parseTags = (raw: unknown): ParseResult<string[] | undefined> => {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) return { ok: false, error: 'tags debe ser array' };
  if (raw.length > MAX_TAGS_PER_CLAIM) return { ok: false, error: 'demasiados tags por claim' };
  const out: string[] = [];
  for (const tag of raw) {
    if (typeof tag !== 'string' || tag.length === 0 || tag.length > MAX_TAG_LEN) {
      return { ok: false, error: 'tag inválido' };
    }
    out.push(tag);
  }
  return { ok: true, value: out };
};

const parseClaim = (raw: unknown, index: number): ParseResult<LibraryClaim> => {
  if (!raw || typeof raw !== 'object') return { ok: false, error: `claim[${index}] debe ser objeto` };
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== 'string' || !ID_PATTERN.test(c.id)) {
    return { ok: false, error: `claim[${index}].id inválido` };
  }
  if (!isNonEmptyString(c.formula, MAX_FORMULA_LEN)) {
    return { ok: false, error: `claim[${index}].formula inválida` };
  }
  if (!isNonEmptyString(c.profile, MAX_PROFILE_LEN)) {
    return { ok: false, error: `claim[${index}].profile inválido` };
  }
  if (!isLibraryClaimKind(c.kind)) {
    return { ok: false, error: `claim[${index}].kind inválido` };
  }
  const tagsResult = parseTags(c.tags);
  if (!tagsResult.ok) return { ok: false, error: `claim[${index}]: ${tagsResult.error}` };

  const claim: LibraryClaim = {
    id: c.id,
    formula: c.formula,
    profile: c.profile,
    kind: c.kind
  };
  if (tagsResult.value !== undefined) claim.tags = tagsResult.value;
  return { ok: true, value: claim };
};

const parseClaims = (raw: unknown): ParseResult<LibraryClaim[]> => {
  if (!Array.isArray(raw)) return { ok: false, error: 'claims debe ser array' };
  if (raw.length > MAX_CLAIMS) return { ok: false, error: 'demasiados claims' };
  const seen = new Set<string>();
  const out: LibraryClaim[] = [];
  for (let i = 0; i < raw.length; i++) {
    const result = parseClaim(raw[i], i);
    if (!result.ok) return { ok: false, error: result.error };
    if (seen.has(result.value.id)) {
      return { ok: false, error: `claim[${i}].id duplicado: ${result.value.id}` };
    }
    seen.add(result.value.id);
    out.push(result.value);
  }
  return { ok: true, value: out };
};

const parseVersion = (raw: unknown): ParseResult<string> => {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_VERSION_LEN) {
    return { ok: false, error: 'version inválida' };
  }
  if (!VERSION_PATTERN.test(raw)) return { ok: false, error: 'version debe ser semver' };
  return { ok: true, value: raw };
};

export const parseLibraryCreateInput = (raw: unknown): ParseResult<STLibraryCreateInput> => {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'payload debe ser objeto' };
  const body = raw as Record<string, unknown>;

  if (!isNonEmptyString(body.name, MAX_NAME_LEN)) return { ok: false, error: 'name inválido' };
  if (typeof body.description !== 'string' || body.description.length > MAX_DESCRIPTION_LEN) {
    return { ok: false, error: 'description inválida' };
  }
  if (!isLibraryVisibility(body.visibility)) return { ok: false, error: 'visibility inválida' };

  const ownerResult = parseOwner(body.owner);
  if (!ownerResult.ok) return { ok: false, error: ownerResult.error };

  const claimsResult = parseClaims(body.claims);
  if (!claimsResult.ok) return { ok: false, error: claimsResult.error };

  const versionResult = parseVersion(body.version);
  if (!versionResult.ok) return { ok: false, error: versionResult.error };

  return {
    ok: true,
    value: {
      name: body.name,
      description: body.description,
      visibility: body.visibility,
      owner: ownerResult.value,
      claims: claimsResult.value,
      version: versionResult.value
    }
  };
};

export const parseLibraryUpdatePatch = (raw: unknown): ParseResult<STLibraryUpdatePatch> => {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'patch debe ser objeto' };
  const body = raw as Record<string, unknown>;
  const patch: STLibraryUpdatePatch = {};

  if (body.name !== undefined) {
    if (!isNonEmptyString(body.name, MAX_NAME_LEN)) return { ok: false, error: 'name inválido' };
    patch.name = body.name;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string' || body.description.length > MAX_DESCRIPTION_LEN) {
      return { ok: false, error: 'description inválida' };
    }
    patch.description = body.description;
  }
  if (body.visibility !== undefined) {
    if (!isLibraryVisibility(body.visibility)) return { ok: false, error: 'visibility inválida' };
    patch.visibility = body.visibility;
  }
  if (body.claims !== undefined) {
    const claimsResult = parseClaims(body.claims);
    if (!claimsResult.ok) return { ok: false, error: claimsResult.error };
    patch.claims = claimsResult.value;
  }
  if (body.version !== undefined) {
    const versionResult = parseVersion(body.version);
    if (!versionResult.ok) return { ok: false, error: versionResult.error };
    patch.version = versionResult.value;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: 'patch vacío' };
  }
  return { ok: true, value: patch };
};

export const VALIDATION_LIMITS = Object.freeze({
  MAX_NAME_LEN,
  MAX_DESCRIPTION_LEN,
  MAX_CLAIMS,
  MAX_FORMULA_LEN,
  MAX_TAG_LEN,
  MAX_TAGS_PER_CLAIM,
  MAX_PROFILE_LEN,
  MAX_VERSION_LEN
});
