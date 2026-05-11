/**
 * Tipos y parsers de borde para el subsistema de remotes Git externos
 * (GitHub, GitLab, Bitbucket, custom). Forgejo sigue siendo source-of-truth;
 * estos remotes son destinos opcionales para push/pull on-demand.
 */

export type RemoteProvider = 'github' | 'gitlab' | 'bitbucket' | 'custom';
export type RemoteAuthMethod = 'ssh-key' | 'token' | 'none';

export interface WorkspaceRemoteRecord {
  id: string;
  workspaceId: string;
  name: string;
  url: string;
  provider: RemoteProvider;
  authMethod: RemoteAuthMethod;
  /** Identificador opaco del secret cifrado (lookup en secretRef del mismo doc). */
  authRef: string | null;
  /** Forgejo es siempre default. Otros remotes nunca son default. */
  isDefault: boolean;
  enabled: boolean;
  lastSyncAt: number | null;
  lastSyncStatus: 'ok' | 'error' | null;
  lastSyncError: string | null;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
}

export interface RemoteCreateInput {
  name: string;
  url: string;
  provider: RemoteProvider;
  authMethod: RemoteAuthMethod;
  /** Plaintext del secret. Se cifra antes de persistir; nunca queda en logs. */
  authData?: string;
}

export interface RemotePatchInput {
  name?: string;
  enabled?: boolean;
  authData?: string;
  authMethod?: RemoteAuthMethod;
}

const PROVIDERS: ReadonlySet<RemoteProvider> = new Set(['github', 'gitlab', 'bitbucket', 'custom']);
const AUTH_METHODS: ReadonlySet<RemoteAuthMethod> = new Set(['ssh-key', 'token', 'none']);

/**
 * Acepta:
 *  - HTTPS: https://host/user/repo(.git)?
 *  - SSH:   git@host:user/repo(.git)?  o  ssh://git@host/user/repo(.git)?
 */
const GIT_URL_PATTERN = /^(https?:\/\/[^\s]+|git@[^\s:]+:[^\s]+|ssh:\/\/[^\s]+)$/;

const MAX_NAME = 64;
const MAX_URL = 512;
const MAX_AUTH_DATA = 16 * 1024;

export const validateRemoteUrl = (url: string): { ok: true } | { ok: false; error: string } => {
  if (typeof url !== 'string') return { ok: false, error: 'url debe ser string' };
  const trimmed = url.trim();
  if (!trimmed) return { ok: false, error: 'url vacía' };
  if (trimmed.length > MAX_URL) return { ok: false, error: `url demasiado larga (>${MAX_URL})` };
  if (!GIT_URL_PATTERN.test(trimmed)) return { ok: false, error: 'url no parece un remote git válido' };
  return { ok: true };
};

export const inferProviderFromUrl = (url: string): RemoteProvider => {
  const lower = url.toLowerCase();
  if (lower.includes('github.com')) return 'github';
  if (lower.includes('gitlab.com') || lower.includes('gitlab.')) return 'gitlab';
  if (lower.includes('bitbucket.org') || lower.includes('bitbucket.')) return 'bitbucket';
  return 'custom';
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

export const parseRemoteCreate = (raw: unknown): { ok: true; value: RemoteCreateInput } | { ok: false; error: string } => {
  if (!isObject(raw)) return { ok: false, error: 'body no es objeto' };
  if (!isStr(raw.name, MAX_NAME)) return { ok: false, error: `name requerido (1-${MAX_NAME} chars)` };
  if (!isStr(raw.url, MAX_URL)) return { ok: false, error: 'url requerido' };
  const urlCheck = validateRemoteUrl(raw.url);
  if (!urlCheck.ok) return { ok: false, error: urlCheck.error };

  const provider = typeof raw.provider === 'string' && PROVIDERS.has(raw.provider as RemoteProvider)
    ? (raw.provider as RemoteProvider)
    : inferProviderFromUrl(raw.url);

  const authMethod = typeof raw.authMethod === 'string' && AUTH_METHODS.has(raw.authMethod as RemoteAuthMethod)
    ? (raw.authMethod as RemoteAuthMethod)
    : 'none';

  let authData: string | undefined;
  if (raw.authData !== undefined && raw.authData !== null) {
    if (typeof raw.authData !== 'string') return { ok: false, error: 'authData debe ser string' };
    if (raw.authData.length > MAX_AUTH_DATA) return { ok: false, error: `authData demasiado largo (>${MAX_AUTH_DATA})` };
    authData = raw.authData;
  }

  if ((authMethod === 'ssh-key' || authMethod === 'token') && !authData) {
    return { ok: false, error: `authData requerido para authMethod=${authMethod}` };
  }

  return {
    ok: true,
    value: {
      name: raw.name.trim(),
      url: raw.url.trim(),
      provider,
      authMethod,
      ...(authData !== undefined ? { authData } : {})
    }
  };
};

export const parseRemotePatch = (raw: unknown): { ok: true; value: RemotePatchInput } | { ok: false; error: string } => {
  if (!isObject(raw)) return { ok: false, error: 'body no es objeto' };
  const out: RemotePatchInput = {};
  if (raw.name !== undefined) {
    if (!isStr(raw.name, MAX_NAME)) return { ok: false, error: 'name inválido' };
    out.name = raw.name.trim();
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') return { ok: false, error: 'enabled debe ser boolean' };
    out.enabled = raw.enabled;
  }
  if (raw.authData !== undefined) {
    if (raw.authData !== null && (typeof raw.authData !== 'string' || raw.authData.length > MAX_AUTH_DATA)) {
      return { ok: false, error: 'authData inválido' };
    }
    if (typeof raw.authData === 'string') out.authData = raw.authData;
  }
  if (raw.authMethod !== undefined) {
    if (typeof raw.authMethod !== 'string' || !AUTH_METHODS.has(raw.authMethod as RemoteAuthMethod)) {
      return { ok: false, error: 'authMethod inválido' };
    }
    out.authMethod = raw.authMethod as RemoteAuthMethod;
  }
  return { ok: true, value: out };
};

/** Versión "safe" del record para devolver al cliente: sin secrets ni authRef opaco. */
export interface WorkspaceRemotePublic {
  id: string;
  workspaceId: string;
  name: string;
  url: string;
  provider: RemoteProvider;
  authMethod: RemoteAuthMethod;
  hasCredentials: boolean;
  isDefault: boolean;
  enabled: boolean;
  lastSyncAt: number | null;
  lastSyncStatus: 'ok' | 'error' | null;
  lastSyncError: string | null;
  createdAt: number;
  updatedAt: number;
}

export const toPublicRemote = (r: WorkspaceRemoteRecord): WorkspaceRemotePublic => ({
  id: r.id,
  workspaceId: r.workspaceId,
  name: r.name,
  url: r.url,
  provider: r.provider,
  authMethod: r.authMethod,
  hasCredentials: r.authRef !== null && r.authRef.length > 0,
  isDefault: r.isDefault,
  enabled: r.enabled,
  lastSyncAt: r.lastSyncAt,
  lastSyncStatus: r.lastSyncStatus,
  lastSyncError: r.lastSyncError,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt
});
