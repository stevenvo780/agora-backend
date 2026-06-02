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
import { materializeRepoAsDocuments, type MaterializeResult } from './materialize-docs';
import type { WorkspaceRemoteRecord } from './types';

export interface GitOpResult {
  ok: boolean;
  /** ref/sha pusheado o pulleado (informativo). */
  ref?: string;
  durationMs: number;
  /** true cuando la operación quedó en estado "pendiente" porque falta soporte
   *  en runtime (ej. SSH sin git binary). El cliente debe ver el motivo. */
  notImplemented?: boolean;
  /** true cuando el pull trajo el contenido del remoto a un workspace
   *  vacío/sin historial (semántica de import: force-push del tree del remoto). */
  imported?: boolean;
  /** Resumen de la materialización de archivos del repo como documentos del
   *  workspace (Firestore + MinIO). Es lo que hace que el user VEA los archivos. */
  materialized?: MaterializeResult;
  error?: string;
}

interface IsoGitModule {
  // Subset de la API que usamos. No importamos tipos completos para no exigir
  // la dep en TS.
  clone: (args: Record<string, unknown>) => Promise<void>;
  push: (args: Record<string, unknown>) => Promise<{ ok?: boolean; errors?: string[] }>;
  pull: (args: Record<string, unknown>) => Promise<void>;
  fetch: (args: Record<string, unknown>) => Promise<unknown>;
  log: (args: Record<string, unknown>) => Promise<Array<{ commit?: { parent?: string[] } }>>;
  listBranches: (args: Record<string, unknown>) => Promise<string[]>;
  resolveRef: (args: Record<string, unknown>) => Promise<string>;
  getRemoteInfo: (args: Record<string, unknown>) => Promise<{ HEAD?: string; refs?: { heads?: Record<string, unknown> } & Record<string, unknown> }>;
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
  /** Branch a sincronizar. Si no se pasa, se resuelve el HEAD real del remote. */
  ref?: string;
  /**
   * Override explícito del caller: forzar la traída del contenido del remoto
   * aunque no sea fast-forward (semántica de import). Cuando no se pasa, el
   * import se detecta automáticamente si el repo Forgejo del workspace está
   * vacío o sólo tiene el commit auto-init (sin historial común).
   */
  force?: boolean;
}

/**
 * Descubre el branch default del remote (su HEAD) sin clonar. Evita asumir
 * `main` cuando el repo usa `master` u otro. `getRemoteInfo` devuelve HEAD como
 * `refs/heads/<branch>`; extraemos el nombre corto.
 */
const resolveDefaultBranch = async (
  deps: IsoGitDeps,
  url: string,
  fallback: string
): Promise<string> => {
  try {
    const info = await deps.git.getRemoteInfo({ http: deps.http, url });
    const head = typeof info.HEAD === 'string' ? info.HEAD : '';
    const short = head.replace(/^refs\/heads\//, '').trim();
    return short || fallback;
  } catch {
    return fallback;
  }
};

const isNotFastForwardError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  const reason = (err as { data?: { reason?: unknown } }).data?.reason;
  if (code === 'PushRejectedError' && reason === 'not-fast-forward') return true;
  const msg = err instanceof Error ? err.message : '';
  return /not a simple fast-forward/i.test(msg);
};

/**
 * Decide si el repo Forgejo del workspace es "importable": vacío (sin commits en
 * la branch destino) o con sólo el commit auto-init (Forgejo crea los repos con
 * `auto_init:true`, dejando un único commit raíz con el README seed). En ambos
 * casos no hay historial del usuario que perder, así que traer el contenido del
 * remoto (force-push del tree) es seguro y es exactamente la semántica de import.
 *
 * Con historial real (>1 commit, o commit con padres) NO es importable: forzar
 * borraría trabajo del usuario. En ese caso el caller debe decidir explícitamente.
 *
 * Usa `depth:1`/`singleBranch` para no traer el packfile completo (evita el OOM
 * que ya se arregló en el clone del remoto).
 */
const isForgejoBranchImportEligible = async (
  deps: IsoGitDeps,
  forgejoUrl: string,
  branch: string
): Promise<boolean> => {
  let info: { refs?: { heads?: Record<string, unknown> } & Record<string, unknown> };
  try {
    info = await deps.git.getRemoteInfo({ http: deps.http, url: forgejoUrl });
  } catch {
    // Si no podemos inspeccionar el destino, no asumimos import: fail-safe.
    return false;
  }
  const heads = (info.refs?.heads ?? {}) as Record<string, unknown>;
  const headNames = Object.keys(heads);
  // Repo totalmente vacío (Forgejo sin auto_init) → importable.
  if (headNames.length === 0) return true;
  if (!(branch in heads)) {
    // La branch destino no existe aún (pero hay otras). Importable a esa branch.
    return true;
  }

  // La branch existe: clonamos shallow para contar commits sin traer todo.
  let probeDir: string | null = null;
  try {
    probeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agora-probe-'));
    await deps.git.clone({
      fs: deps.fsAdapter, http: deps.http, dir: probeDir, url: forgejoUrl,
      singleBranch: true, ref: branch, depth: 2
    });
    const history = await deps.git.log({ fs: deps.fsAdapter, dir: probeDir, ref: branch, depth: 2 });
    if (history.length === 0) return true;
    if (history.length > 1) return false;
    // Exactamente un commit: importable sólo si es un commit raíz (auto-init),
    // i.e. sin padres. Un único commit con padres sería historial truncado por depth.
    const parents = history[0]?.commit?.parent ?? [];
    return parents.length === 0;
  } catch {
    return false;
  } finally {
    if (probeDir) await fs.rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

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
    const ref = args.ref ?? await resolveDefaultBranch(deps, forgejoCloneUrl, 'main');
    await deps.git.clone({
      fs: deps.fsAdapter, http: deps.http, dir: workdir, url: forgejoCloneUrl,
      singleBranch: true, ref
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

    const ref = args.ref ?? await resolveDefaultBranch(deps, externalUrl, 'main');

    await deps.git.clone({
      fs: deps.fsAdapter, http: deps.http, dir: workdir, url: externalUrl,
      singleBranch: true, ref
    });

    const forgejoUrl = buildForgejoCloneUrl(args.workspaceId, args.ownerUid, args.repoName);

    const pushOnce = async (force: boolean) => deps.git.push({
      fs: deps.fsAdapter, http: deps.http, dir: workdir, url: forgejoUrl, ref, remoteRef: ref, force
    });

    let imported = false;
    let pushRes: { ok?: boolean; errors?: string[] } | undefined;
    try {
      pushRes = await pushOnce(false);
    } catch (pushErr) {
      // Caso import: el repo del workspace no comparte historia con el remoto
      // (vacío o sólo el commit auto-init de Forgejo) → no es fast-forward.
      // Traemos el contenido del remoto force-pusheando, en vez de fallar.
      if (!isNotFastForwardError(pushErr)) throw pushErr;
      const eligible = args.force === true
        || await isForgejoBranchImportEligible(deps, forgejoUrl, ref);
      if (!eligible) {
        return {
          ok: false,
          durationMs: Date.now() - t0,
          error: 'El workspace ya tiene historial propio que no comparte ancestro con el remoto. ' +
            'Para sobrescribirlo con el contenido del remoto reenviá la operación con force:true.'
        };
      }
      pushRes = await pushOnce(true);
      imported = true;
    }

    if (pushRes && Array.isArray(pushRes.errors) && pushRes.errors.length > 0) {
      return { ok: false, durationMs: Date.now() - t0, error: pushRes.errors.join('; ') };
    }

    // Lo que el user realmente quiere: que los archivos del repo APAREZCAN como
    // documentos del workspace. El push a Forgejo es la capa git; acá
    // materializamos cada archivo del repo clonado (en `workdir`, aún sin borrar)
    // como doc Firestore + blob MinIO usando el path canónico de creación.
    let materialized: MaterializeResult | undefined;
    try {
      materialized = await materializeRepoAsDocuments(workdir, {
        workspaceId: args.workspaceId,
        ownerUid: args.ownerUid
      });
    } catch (matErr) {
      console.warn('[remotes/pull] materialización de docs falló', sanitizeError(matErr, token));
    }

    const sha = await deps.git.resolveRef({ fs: deps.fsAdapter, dir: workdir, ref }).catch(() => undefined);
    return {
      ok: true,
      ref: sha,
      durationMs: Date.now() - t0,
      ...(imported ? { imported: true } : {}),
      ...(materialized ? { materialized } : {})
    };
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
