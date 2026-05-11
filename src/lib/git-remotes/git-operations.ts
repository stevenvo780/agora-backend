/**
 * Operaciones git push/pull entre el repo Forgejo del workspace y un remote
 * externo (GitHub, GitLab, etc).
 *
 * Estrategia:
 *   - HTTPS + token: usamos `isomorphic-git` con cliente HTTP de node si está
 *     instalado. No requiere binario `git` en la imagen Cloud Run.
 *   - SSH key: requiere `git` + `ssh` instalados. Como la imagen actual
 *     (node:22-alpine, ver AgoraBack/Dockerfile) NO los trae, devolvemos
 *     `notImplemented:true` con guidance.
 *
 * Pendiente: para soportar SSH en Cloud Run agregar al Dockerfile:
 *     RUN apk add --no-cache git openssh
 * y reemplazar la rama ssh-key por execFile('git', [...], { env: {...} }).
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { getForgejoApiUrl, getForgejoOrg } from '@/lib/forgejo';
import { env } from '@/lib/env';
import { decryptSecret, buildAuthenticatedHttpsUrl, redactSecretFromError } from './secret-vault';
import type { WorkspaceRemoteRecord } from './types';

export interface GitOpResult {
  ok: boolean;
  /** ref/sha pusheado o pulleado (informativo). */
  ref?: string;
  durationMs: number;
  /** true cuando la operación quedó en estado "pendiente" porque falta soporte
   *  en runtime (ej. SSH sin git binary). El cliente debe ver el motivo. */
  notImplemented?: boolean;
  error?: string;
}

interface IsoGitModule {
  // Subset de la API que usamos. No importamos tipos completos para no exigir
  // la dep en TS.
  clone: (args: Record<string, unknown>) => Promise<void>;
  push: (args: Record<string, unknown>) => Promise<{ ok?: boolean; errors?: string[] }>;
  pull: (args: Record<string, unknown>) => Promise<void>;
  fetch: (args: Record<string, unknown>) => Promise<unknown>;
  listBranches: (args: Record<string, unknown>) => Promise<string[]>;
  resolveRef: (args: Record<string, unknown>) => Promise<string>;
}

interface IsoHttpModule {
  default: unknown;
}

interface IsoGitDeps {
  git: IsoGitModule;
  http: unknown;
  fsAdapter: unknown;
}

let cachedDeps: IsoGitDeps | null | undefined;

const loadIsomorphicGit = async (): Promise<IsoGitDeps | null> => {
  if (cachedDeps !== undefined) return cachedDeps;
  try {
    const dynImport = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>;
    const gitMod = await dynImport('isomorphic-git') as IsoGitModule;
    const httpMod = await dynImport('isomorphic-git/http/node') as IsoHttpModule;
    cachedDeps = { git: gitMod, http: httpMod.default ?? httpMod, fsAdapter: fs };
    return cachedDeps;
  } catch {
    cachedDeps = null;
    return null;
  }
};

/** URL del repo Forgejo del workspace, autenticada con admin token (uso server-side). */
const buildForgejoCloneUrl = (workspaceId: string, ownerUid: string, repoName: string): string => {
  const apiBase = getForgejoApiUrl();
  if (!apiBase) throw new Error('FORGEJO_API_URL no configurado');
  // Derivamos el host base sin la ruta /api/v1.
  const apiUrl = new URL(apiBase);
  const adminToken = env.FORGEJO_ADMIN_TOKEN();
  if (!adminToken) throw new Error('FORGEJO_ADMIN_TOKEN no configurado');
  apiUrl.pathname = '';
  apiUrl.username = 'agora-admin';
  apiUrl.password = encodeURIComponent(adminToken);
  void workspaceId; void ownerUid;
  return `${apiUrl.toString().replace(/\/$/, '')}/${getForgejoOrg()}/${repoName}.git`;
};

const sanitizeError = (err: unknown, secret: string | null): string => {
  const msg = err instanceof Error ? err.message : String(err);
  return redactSecretFromError(msg, secret);
};

const resolveAuthForRemote = (remote: WorkspaceRemoteRecord, cipher: string | null): { token: string | null; sshKey: string | null } => {
  if (!cipher) return { token: null, sshKey: null };
  const plain = decryptSecret(cipher);
  if (plain === null) return { token: null, sshKey: null };
  if (remote.authMethod === 'token') return { token: plain, sshKey: null };
  if (remote.authMethod === 'ssh-key') return { token: null, sshKey: plain };
  return { token: null, sshKey: null };
};

interface ExecuteArgs {
  workspaceId: string;
  ownerUid: string;
  repoName: string;
  remote: WorkspaceRemoteRecord;
  encryptedSecret: string | null;
  /** Branch a sincronizar. Default `main`. */
  ref?: string;
}

/**
 * Push del repo Forgejo → remote externo. Idea: clonar Forgejo a un dir tmp,
 * añadir el remote externo, push.
 *
 * Limitaciones actuales:
 *  - SSH no soportado en runtime (Alpine sin git). Devuelve notImplemented.
 *  - Sin isomorphic-git instalado, devuelve notImplemented.
 */
export const pushToExternalRemote = async (args: ExecuteArgs): Promise<GitOpResult> => {
  const t0 = Date.now();
  const ref = args.ref ?? 'main';
  const { remote, encryptedSecret } = args;

  if (remote.authMethod === 'ssh-key') {
    return {
      ok: false,
      durationMs: Date.now() - t0,
      notImplemented: true,
      error: 'SSH push aún no soportado en runtime Cloud Run. Usa authMethod=token (HTTPS) o configura git+ssh en la imagen.'
    };
  }

  const deps = await loadIsomorphicGit();
  if (!deps) {
    return {
      ok: false,
      durationMs: Date.now() - t0,
      notImplemented: true,
      error: 'isomorphic-git no instalado en el runtime. Agregar `npm i isomorphic-git` y redeploy.'
    };
  }

  const { token } = resolveAuthForRemote(remote, encryptedSecret);
  if (remote.authMethod === 'token' && !token) {
    return { ok: false, durationMs: Date.now() - t0, error: 'Token no recuperable del vault (auth-tag inválido o falta).' };
  }

  let workdir: string | null = null;
  try {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), `agora-remote-${remote.id}-`));
    const forgejoCloneUrl = buildForgejoCloneUrl(args.workspaceId, args.ownerUid, args.repoName);
    await deps.git.clone({
      fs: deps.fsAdapter, http: deps.http, dir: workdir, url: forgejoCloneUrl,
      singleBranch: true, ref, depth: 50
    });

    const externalUrl = remote.authMethod === 'token' && token
      ? buildAuthenticatedHttpsUrl(remote.url, token)
      : remote.url;

    const pushRes = await deps.git.push({
      fs: deps.fsAdapter, http: deps.http, dir: workdir, url: externalUrl, ref, remoteRef: ref, force: false
    });

    if (pushRes && Array.isArray(pushRes.errors) && pushRes.errors.length > 0) {
      return { ok: false, durationMs: Date.now() - t0, error: pushRes.errors.join('; ') };
    }
    const sha = await deps.git.resolveRef({ fs: deps.fsAdapter, dir: workdir, ref }).catch(() => undefined);
    return { ok: true, ref: sha, durationMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, durationMs: Date.now() - t0, error: sanitizeError(e, token) };
  } finally {
    if (workdir) await fs.rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
};

/**
 * Pull desde el remote externo → Forgejo. Clona el externo, agrega Forgejo
 * como remote y pushea. Mismas limitaciones que pushToExternalRemote.
 */
export const pullFromExternalRemote = async (args: ExecuteArgs): Promise<GitOpResult> => {
  const t0 = Date.now();
  const ref = args.ref ?? 'main';
  const { remote, encryptedSecret } = args;

  if (remote.authMethod === 'ssh-key') {
    return {
      ok: false,
      durationMs: Date.now() - t0,
      notImplemented: true,
      error: 'SSH pull aún no soportado en runtime Cloud Run. Usa authMethod=token (HTTPS) o configura git+ssh en la imagen.'
    };
  }

  const deps = await loadIsomorphicGit();
  if (!deps) {
    return {
      ok: false,
      durationMs: Date.now() - t0,
      notImplemented: true,
      error: 'isomorphic-git no instalado en el runtime. Agregar `npm i isomorphic-git` y redeploy.'
    };
  }

  const { token } = resolveAuthForRemote(remote, encryptedSecret);
  if (remote.authMethod === 'token' && !token) {
    return { ok: false, durationMs: Date.now() - t0, error: 'Token no recuperable del vault.' };
  }

  let workdir: string | null = null;
  try {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), `agora-pull-${remote.id}-`));
    const externalUrl = remote.authMethod === 'token' && token
      ? buildAuthenticatedHttpsUrl(remote.url, token)
      : remote.url;

    await deps.git.clone({
      fs: deps.fsAdapter, http: deps.http, dir: workdir, url: externalUrl,
      singleBranch: true, ref, depth: 50
    });

    const forgejoUrl = buildForgejoCloneUrl(args.workspaceId, args.ownerUid, args.repoName);
    const pushRes = await deps.git.push({
      fs: deps.fsAdapter, http: deps.http, dir: workdir, url: forgejoUrl, ref, remoteRef: ref, force: false
    });
    if (pushRes && Array.isArray(pushRes.errors) && pushRes.errors.length > 0) {
      return { ok: false, durationMs: Date.now() - t0, error: pushRes.errors.join('; ') };
    }
    const sha = await deps.git.resolveRef({ fs: deps.fsAdapter, dir: workdir, ref }).catch(() => undefined);
    return { ok: true, ref: sha, durationMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, durationMs: Date.now() - t0, error: sanitizeError(e, token) };
  } finally {
    if (workdir) await fs.rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
};

/** Solo para verificar al arranque/test si el runtime tiene la dep. */
export const isGitRuntimeAvailable = async (): Promise<boolean> => {
  const deps = await loadIsomorphicGit();
  return deps !== null;
};
