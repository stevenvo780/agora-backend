import crypto from 'node:crypto';
import { parseForgejoTokenResponse } from '@agora/contracts';
import { env } from '@/lib/env';

/**
 * Forgejo API client.
 *
 * Modelo:
 * - 1 user Forgejo `agora-<uid>` por usuario Agora (creado al primer provisioning).
 * - 1 repo por workspace, en la org `agora` (FORGEJO_ORG):
 *     · personal workspace → `agora/personal-<uid>`
 *     · shared workspace   → `agora/<wsId>`
 *   Cada workspace = un proyecto git separado, con miembros como collaborators.
 *
 * Idempotente.
 *
 * Forgejo no expone `POST /admin/users/<login>/tokens` (404). Para emitir un
 * token a nombre de un usuario hacemos Basic Auth con su password efímero
 * (generado al crear el user; nunca se persiste).
 */

const apiUrl = env.FORGEJO_API_URL() || undefined;
const adminToken = env.FORGEJO_ADMIN_TOKEN() || undefined;
const org = env.FORGEJO_ORG();

export const isForgejoConfigured = (): boolean => Boolean(apiUrl && adminToken);
export const getForgejoOrg = (): string => org;
export const getForgejoApiUrl = (): string | null => apiUrl ?? null;

const adminHeaders = (): HeadersInit => ({
  Accept: 'application/json',
  'Content-Type': 'application/json',
  Authorization: `token ${adminToken}`
});

const fetchAdmin = async <T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: T | null; raw: string }> => {
  if (!isForgejoConfigured()) throw new Error('Forgejo not configured');
  const res = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { ...adminHeaders(), ...(init.headers ?? {}) }
  });
  const raw = await res.text();
  let body: T | null = null;
  if (raw) {
    try { body = JSON.parse(raw) as T; } catch { /* not json */ }
  }
  return { status: res.status, body, raw };
};

const fetchAsUser = async <T = unknown>(
  login: string,
  password: string,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: T | null; raw: string }> => {
  if (!apiUrl) throw new Error('FORGEJO_API_URL required');
  const basic = Buffer.from(`${login}:${password}`).toString('base64');
  const res = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Basic ${basic}`,
      ...(init.headers ?? {})
    }
  });
  const raw = await res.text();
  let body: T | null = null;
  if (raw) {
    try { body = JSON.parse(raw) as T; } catch { /* not json */ }
  }
  return { status: res.status, body, raw };
};

export interface ForgejoUser {
  id: number;
  login: string;
  email?: string;
  full_name?: string;
}

export interface ForgejoRepo {
  id: number;
  full_name: string;
  clone_url: string;
  ssh_url: string;
  html_url: string;
  private: boolean;
}

const slugify = (s: string): string =>
  s.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase().slice(0, 64) || 'item';

export const userLoginFor = (uid: string): string => `agora-${slugify(uid)}`;

export const repoNameForWorkspace = (workspaceId: string, ownerUid: string): string => {
  if (workspaceId === 'personal' || workspaceId.startsWith('personal:')) {
    return `personal-${slugify(ownerUid)}`;
  }
  return slugify(workspaceId);
};

/**
 * Borra el repo asociado al workspace en Forgejo. Idempotente: 404 → no-op.
 * Acepta tanto un `repoFullName` (`org/repo`) ya conocido como derivarlo desde
 * `workspaceId + ownerUid`.
 */
export const deleteForgejoRepo = async (params: { repoFullName?: string; workspaceId?: string; ownerUid?: string }): Promise<boolean> => {
  let target = params.repoFullName;
  if (!target && params.workspaceId && params.ownerUid) {
    target = `${org}/${repoNameForWorkspace(params.workspaceId, params.ownerUid)}`;
  }
  if (!target) return false;
  const res = await fetchAdmin(`/api/v1/repos/${target}`, { method: 'DELETE' });
  return res.status >= 200 && res.status < 300;
};

export const ensureOrgExists = async (): Promise<void> => {
  const probe = await fetchAdmin<{ id: number }>(`/api/v1/orgs/${org}`);
  if (probe.status === 200) return;
  const created = await fetchAdmin(`/api/v1/orgs`, {
    method: 'POST',
    body: JSON.stringify({ username: org, visibility: 'private', description: 'Repos de workspaces de Agora' })
  });
  if (created.status >= 400 && created.status !== 422 && created.status !== 409) {
    throw new Error(`Failed to ensure org ${org}: ${created.status} ${created.raw.slice(0, 200)}`);
  }
};

interface EnsureUserResult {
  user: ForgejoUser;
  justCreated: boolean;
  password: string | null;
}

const validUser = (u: unknown): u is ForgejoUser => {
  return Boolean(u && typeof u === 'object' && typeof (u as ForgejoUser).login === 'string' && (u as ForgejoUser).login.length > 0);
};

const ensureForgejoUser = async (uid: string, email?: string, displayName?: string): Promise<EnsureUserResult> => {
  const login = userLoginFor(uid);

  const probe = await fetchAdmin<ForgejoUser>(`/api/v1/users/${login}`);
  if (probe.status === 200 && validUser(probe.body)) {
    return { user: probe.body, justCreated: false, password: null };
  }

  const password = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
  // Email único por intento — Forgejo bloquea reuse de emails entre users
  // (incluso post-purge en algunas versiones), causando 422 fantasma.
  const uniqueSuffix = crypto.randomUUID().slice(0, 8);
  const fallbackEmail = `${login}-${uniqueSuffix}@noreply.agora.local`;
  const created = await fetchAdmin<ForgejoUser>('/api/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      username: login,
      email: email || fallbackEmail,
      password,
      full_name: displayName || login,
      must_change_password: false,
      send_notify: false
    })
  });

  // Si el email real del user Agora colisiona en Forgejo, reintentar con email único.
  if (created.status === 422 && email) {
    const retry = await fetchAdmin<ForgejoUser>('/api/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: login,
        email: fallbackEmail,
        password,
        full_name: displayName || login,
        must_change_password: false,
        send_notify: false
      })
    });
    if (validUser(retry.body)) {
      return { user: retry.body, justCreated: true, password };
    }
  }

  // 422 = ya existe; cualquier otro >=400 es error real.
  if (created.status >= 400 && created.status !== 422) {
    throw new Error(`Failed to create Forgejo user ${login}: ${created.status} ${created.raw.slice(0, 200)}`);
  }

  if (validUser(created.body)) {
    return { user: created.body, justCreated: created.status < 400, password };
  }

  // Body inválido o vacío — refetch obligatorio.
  const re = await fetchAdmin<ForgejoUser>(`/api/v1/users/${login}`);
  if (!validUser(re.body)) {
    throw new Error(`Forgejo user ${login} no se pudo verificar tras create (status=${created.status}, refetch=${re.status}, body=${(re.raw || '').slice(0,150)})`);
  }
  return { user: re.body, justCreated: false, password: null };
};

const ensureRepoForWorkspace = async (params: {
  ownerUid: string;
  workspaceId: string;
  workspaceName?: string;
  description?: string;
}): Promise<{ repo: ForgejoRepo; created: boolean }> => {
  const repoName = repoNameForWorkspace(params.workspaceId, params.ownerUid);
  const probe = await fetchAdmin<ForgejoRepo>(`/api/v1/repos/${org}/${repoName}`);
  if (probe.status === 200 && probe.body) return { repo: probe.body, created: false };

  const description = params.description
    || `Workspace ${params.workspaceName || params.workspaceId} de ${params.ownerUid}`;
  const created = await fetchAdmin<ForgejoRepo>(`/api/v1/orgs/${org}/repos`, {
    method: 'POST',
    body: JSON.stringify({
      name: repoName,
      description,
      private: true,
      auto_init: true,
      default_branch: 'main',
      readme: 'Default'
    })
  });
  if (created.status >= 400 && created.status !== 409) {
    throw new Error(`Failed to create repo ${org}/${repoName}: ${created.status} ${created.raw.slice(0, 200)}`);
  }
  if (created.body) return { repo: created.body, created: true };
  const re = await fetchAdmin<ForgejoRepo>(`/api/v1/repos/${org}/${repoName}`);
  if (!re.body) throw new Error(`Repo ${org}/${repoName} not found after create`);
  return { repo: re.body, created: false };
};

export const grantWriteAccess = async (repoName: string, login: string): Promise<void> => {
  await fetchAdmin(`/api/v1/repos/${org}/${repoName}/collaborators/${login}`, {
    method: 'PUT',
    body: JSON.stringify({ permission: 'write' })
  });
};

export interface ProvisionWorkspaceResult {
  repo: ForgejoRepo;
  forgejoUser: ForgejoUser;
  /** true si se creó user o repo en esta llamada */
  created: boolean;
  /** token solo cuando ACABAMOS de crear el user (luego es null). */
  token: string | null;
  tokenName: string | null;
}

/**
 * Asegura org + user + repo del workspace + collaborator.
 * Si el user es nuevo, emite un token inicial (devuelto una sola vez).
 *
 * Para shared workspaces, pasar `extraCollaborators` con los uids de miembros
 * (esta función asegura que cada uno tenga su user Forgejo y collaborator del repo).
 */
export const provisionWorkspaceRepo = async (params: {
  ownerUid: string;
  email?: string;
  displayName?: string;
  workspaceId: string;
  workspaceName?: string;
  extraCollaborators?: string[];
}): Promise<ProvisionWorkspaceResult> => {
  await ensureOrgExists();

  const userResult = await ensureForgejoUser(params.ownerUid, params.email, params.displayName);
  const repoResult = await ensureRepoForWorkspace({
    ownerUid: params.ownerUid,
    workspaceId: params.workspaceId,
    workspaceName: params.workspaceName
  });

  await grantWriteAccess(
    repoNameForWorkspace(params.workspaceId, params.ownerUid),
    userResult.user.login
  );

  for (const uid of params.extraCollaborators ?? []) {
    if (uid === params.ownerUid) continue;
    try {
      const sub = await ensureForgejoUser(uid);
      await grantWriteAccess(
        repoNameForWorkspace(params.workspaceId, params.ownerUid),
        sub.user.login
      );
    } catch (err) {
      console.warn('[forgejo] collaborator setup failed for', uid, (err as Error).message);
    }
  }

  let token: string | null = null;
  let tokenName: string | null = null;
  if (userResult.justCreated && userResult.password) {
    tokenName = `agora-initial-${Date.now()}`;
    const t = await fetchAsUser(
      userResult.user.login,
      userResult.password,
      `/api/v1/users/${userResult.user.login}/tokens`,
      { method: 'POST', body: JSON.stringify({ name: tokenName, scopes: ['write:repository', 'read:repository', 'read:user'] }) }
    );
    const parsedToken = parseForgejoTokenResponse(t.body);
    if (parsedToken.ok) token = parsedToken.value.sha1;
  }

  return {
    repo: repoResult.repo,
    forgejoUser: userResult.user,
    created: userResult.justCreated || repoResult.created,
    token,
    tokenName
  };
};

/**
 * Resetea password admin → emite token PAT → restaura password random.
 * Pensado para que el cliente browser obtenga un token nuevo cuando se le perdió
 * el inicial (provisioning) o cuando el admin lo revocó.
 */
export const issueTokenForUser = async (uid: string, tokenName: string, scopes: string[] = ['write:repository', 'read:repository', 'read:user']): Promise<string | null> => {
  const login = userLoginFor(uid);
  // Probe: el user debe existir.
  const probe = await fetchAdmin<ForgejoUser>(`/api/v1/users/${login}`);
  if (probe.status !== 200 || !validUser(probe.body)) return null;

  const tempPassword = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
  // PATCH user con nueva password (admin endpoint).
  const patched = await fetchAdmin(`/api/v1/admin/users/${login}`, {
    method: 'PATCH',
    body: JSON.stringify({ password: tempPassword, must_change_password: false, source_id: 0, login_name: login })
  });
  if (patched.status >= 400) return null;

  // POST token con basic auth.
  const t = await fetchAsUser(login, tempPassword, `/api/v1/users/${login}/tokens`, {
    method: 'POST',
    body: JSON.stringify({ name: tokenName, scopes })
  });
  const parsed = parseForgejoTokenResponse(t.body);

  // Re-set password a algo random no-recuperable (el user accede por token, no por password).
  // Se hace SIEMPRE — incluso si el token failed — para no dejar tempPassword vivo.
  const newRandomPwd = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
  await fetchAdmin(`/api/v1/admin/users/${login}`, {
    method: 'PATCH',
    body: JSON.stringify({ password: newRandomPwd, must_change_password: false, source_id: 0 })
  });

  return parsed.ok ? parsed.value.sha1 : null;
};

export interface MigrateRepoParams {
  ownerUid: string;
  email?: string;
  displayName?: string;
  cloneAddr: string;
  repoName?: string;
  description?: string;
  authToken?: string;
  authUsername?: string;
  authPassword?: string;
  private?: boolean;
  mirror?: boolean;
}

/**
 * Importa un repo externo a Forgejo via la API de migración. Asegura que el
 * user `agora-<uid>` exista (lo crea si hace falta), y crea un repo nuevo
 * en la org `agora` clonado del `cloneAddr`. La migración la hace Forgejo
 * server-side, sin necesidad de tener `git` CLI en este proceso.
 */
export const migrateRepo = async (params: MigrateRepoParams): Promise<ForgejoRepo> => {
  await ensureOrgExists();
  const userResult = await ensureForgejoUser(params.ownerUid, params.email, params.displayName);

  const baseName = params.repoName?.trim() || params.cloneAddr.split('/').pop()?.replace(/\.git$/, '') || 'imported';
  const safeName = slugify(baseName);

  const body: Record<string, unknown> = {
    clone_addr: params.cloneAddr,
    repo_name: safeName,
    repo_owner: org,
    service: 'git',
    private: params.private !== false,
    mirror: params.mirror === true,
    wiki: false,
    issues: false,
    pull_requests: false,
    releases: false
  };
  if (params.description) body.description = params.description;
  if (params.authToken) body.auth_token = params.authToken;
  if (params.authUsername) body.auth_username = params.authUsername;
  if (params.authPassword) body.auth_password = params.authPassword;

  const migrate = await fetchAdmin<ForgejoRepo>(`/api/v1/repos/migrate`, {
    method: 'POST',
    body: JSON.stringify(body)
  });
  if (migrate.status === 409) {
    throw new Error(`Ya existe un repo con el nombre "${safeName}". Cámbialo y reintenta.`);
  }
  if (migrate.status >= 400 || !migrate.body) {
    throw new Error(`Forgejo migrate falló (${migrate.status}): ${migrate.raw.slice(0, 300)}`);
  }

  await grantWriteAccess(safeName, userResult.user.login).catch(() => undefined);
  return migrate.body;
};

/** Lista repos accesibles para un user (usa búsqueda admin). */
export const listUserRepos = async (uid: string): Promise<ForgejoRepo[]> => {
  const login = userLoginFor(uid);
  const r = await fetchAdmin<{ data?: ForgejoRepo[] }>(
    `/api/v1/users/search?q=${encodeURIComponent(login)}&limit=1`
  );
  if (r.status !== 200 || !r.body) return [];
  // Hay que listar repos a los que es collaborator: /repos/search
  const search = await fetchAdmin<{ data?: ForgejoRepo[] }>(
    `/api/v1/repos/search?owner=${org}&limit=50`
  );
  if (search.status !== 200 || !search.body?.data) return [];
  // Filtrar solo los que el user puede ver (heurística: incluyen su login en collaborators).
  // Como el endpoint admin pasa filtros, devolvemos todos los repos de la org;
  // el frontend ya sabe qué workspaces tiene y mapea por nombre.
  return search.body.data;
};
