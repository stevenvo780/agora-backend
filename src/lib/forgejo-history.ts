/**
 * Forgejo helpers para vistas enriquecidas de historia, diff, branches y
 * revert. Complementa `forgejo-git.ts` (que enfoca en commit y árbol).
 *
 * Todos los helpers consultan Forgejo via fetch directo con el admin token.
 * No usan `forgejo-git.ts` para evitar tocar ese archivo (conflicto con
 * la rama `feature/atomic-commits`).
 */
import { env } from '@/lib/env';
import { applyCommit, type CommitChange } from '@/lib/forgejo-git';

const apiUrl = (): string => {
  const v = env.FORGEJO_API_URL();
  if (!v) throw new Error('FORGEJO_API_URL required');
  return v;
};

const adminToken = (): string => env.FORGEJO_ADMIN_TOKEN() || '';

const adminHeaders = (): HeadersInit => ({
  Accept: 'application/json',
  'Content-Type': 'application/json',
  Authorization: `token ${adminToken()}`
});

const PATCH_PER_FILE_LIMIT = 1024 * 1024; // 1 MB

export interface ForgejoBranch {
  name: string;
  commit: { id: string; message?: string };
}

export interface ForgejoTag {
  name: string;
  id: string;
  commit?: { sha?: string };
}

export interface ForgejoCommitWithParents {
  sha: string;
  html_url: string;
  parents: Array<{ sha: string; url: string }>;
  commit: {
    message: string;
    author: { name: string; email: string; date: string };
  };
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  patch: string;
}

export interface DiffResponse {
  files: DiffFile[];
  stats: { totalAdditions: number; totalDeletions: number; totalFiles: number };
  truncated: boolean;
}

export const listBranches = async (repoFullName: string): Promise<ForgejoBranch[]> => {
  const out: ForgejoBranch[] = [];
  let page = 1;
  for (;;) {
    const r = await fetch(`${apiUrl()}/api/v1/repos/${repoFullName}/branches?page=${page}&limit=50`, {
      headers: adminHeaders()
    });
    if (!r.ok) break;
    const arr = (await r.json()) as ForgejoBranch[];
    if (!Array.isArray(arr) || arr.length === 0) break;
    out.push(...arr);
    if (arr.length < 50) break;
    page++;
    if (page > 20) break;
  }
  return out;
};

export const listTags = async (repoFullName: string): Promise<ForgejoTag[]> => {
  const r = await fetch(`${apiUrl()}/api/v1/repos/${repoFullName}/tags?limit=50`, {
    headers: adminHeaders()
  });
  if (!r.ok) return [];
  const arr = (await r.json()) as ForgejoTag[];
  return Array.isArray(arr) ? arr : [];
};

export const getRepoMeta = async (repoFullName: string): Promise<{ defaultBranch: string } | null> => {
  const r = await fetch(`${apiUrl()}/api/v1/repos/${repoFullName}`, { headers: adminHeaders() });
  if (!r.ok) return null;
  const body = (await r.json()) as { default_branch?: string };
  return { defaultBranch: body.default_branch ?? 'main' };
};

export const listCommitsWithParents = async (
  repoFullName: string,
  limit = 50,
  ref?: string
): Promise<ForgejoCommitWithParents[]> => {
  const qs = new URLSearchParams();
  qs.set('limit', String(Math.min(Math.max(1, limit), 200)));
  qs.set('stat', 'false');
  qs.set('verification', 'false');
  if (ref) qs.set('sha', ref);
  const r = await fetch(`${apiUrl()}/api/v1/repos/${repoFullName}/commits?${qs}`, {
    headers: adminHeaders()
  });
  if (!r.ok) return [];
  const arr = (await r.json()) as ForgejoCommitWithParents[];
  return Array.isArray(arr) ? arr : [];
};

export const getCommitWithParents = async (
  repoFullName: string,
  sha: string
): Promise<ForgejoCommitWithParents | null> => {
  const r = await fetch(`${apiUrl()}/api/v1/repos/${repoFullName}/git/commits/${sha}`, {
    headers: adminHeaders()
  });
  if (r.ok) {
    const body = (await r.json()) as ForgejoCommitWithParents;
    if (body && typeof body.sha === 'string') return body;
  }
  // Fallback al endpoint de commits "regular" que sí incluye author + message
  // bajo otro shape pero con `parents`.
  const r2 = await fetch(`${apiUrl()}/api/v1/repos/${repoFullName}/commits/${sha}?stat=false&verification=false`, {
    headers: adminHeaders()
  });
  if (!r2.ok) return null;
  const body = (await r2.json()) as ForgejoCommitWithParents;
  return body && typeof body.sha === 'string' ? body : null;
};

/**
 * Parsea un diff unificado multi-archivo (formato `git format-patch` /
 * `git diff`) en una lista de `DiffFile`. Trunca el `patch` por archivo
 * a `PATCH_PER_FILE_LIMIT` bytes.
 *
 * No depende de libs externas porque el formato es estable y simple:
 *   diff --git a/path b/path
 *   <header lines: index, ---, +++, rename, new file, deleted file>
 *   @@ ... @@
 *   <hunk lines>
 */
export const parseUnifiedDiff = (raw: string): { files: DiffFile[]; truncated: boolean } => {
  const files: DiffFile[] = [];
  let truncated = false;
  if (!raw) return { files, truncated };

  const lines = raw.split('\n');
  let cursor = 0;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (typeof line !== 'string' || !line.startsWith('diff --git ')) {
      cursor++;
      continue;
    }
    // Cabecera: extraer paths.
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    let aPath = m?.[1] ?? '';
    let bPath = m?.[2] ?? '';
    let status: DiffFile['status'] = 'modified';
    let oldPath: string | undefined;
    let buf: string[] = [line];
    cursor++;
    let additions = 0;
    let deletions = 0;
    while (cursor < lines.length) {
      const next = lines[cursor];
      if (typeof next !== 'string') { cursor++; continue; }
      if (next.startsWith('diff --git ')) break;
      buf.push(next);
      if (next.startsWith('new file mode')) status = 'added';
      else if (next.startsWith('deleted file mode')) status = 'removed';
      else if (next.startsWith('rename from ')) {
        oldPath = next.slice('rename from '.length).trim();
        status = 'renamed';
      } else if (next.startsWith('rename to ')) {
        bPath = next.slice('rename to '.length).trim();
      } else if (next.startsWith('+') && !next.startsWith('+++')) {
        additions++;
      } else if (next.startsWith('-') && !next.startsWith('---')) {
        deletions++;
      }
      cursor++;
    }
    const patchRaw = buf.join('\n');
    const patch = patchRaw.length > PATCH_PER_FILE_LIMIT
      ? patchRaw.slice(0, PATCH_PER_FILE_LIMIT) + '\n[... truncated ...]'
      : patchRaw;
    if (patchRaw.length > PATCH_PER_FILE_LIMIT) truncated = true;
    files.push({
      path: status === 'removed' ? aPath : bPath,
      ...(oldPath ? { oldPath } : {}),
      status,
      additions,
      deletions,
      patch
    });
  }
  return { files, truncated };
};

export const compareRefs = async (
  repoFullName: string,
  base: string,
  head: string
): Promise<DiffResponse | null> => {
  const url = `${apiUrl()}/api/v1/repos/${repoFullName}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}.diff`;
  const r = await fetch(url, {
    headers: { Accept: 'text/plain', Authorization: `token ${adminToken()}` }
  });
  if (r.status === 404) return null;
  if (!r.ok) return null;
  const raw = await r.text();
  const parsed = parseUnifiedDiff(raw);
  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const f of parsed.files) {
    totalAdditions += f.additions;
    totalDeletions += f.deletions;
  }
  return {
    files: parsed.files,
    stats: { totalAdditions, totalDeletions, totalFiles: parsed.files.length },
    truncated: parsed.truncated
  };
};

export const getFileContentAtRef = async (
  repoFullName: string,
  path: string,
  ref: string
): Promise<{ sha: string; content: Buffer } | null> => {
  const url = `${apiUrl()}/api/v1/repos/${repoFullName}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`;
  const r = await fetch(url, { headers: adminHeaders() });
  if (!r.ok) return null;
  const body = (await r.json()) as { sha?: string; encoding?: string; content?: string; download_url?: string };
  if (!body || typeof body.sha !== 'string') return null;
  if (body.encoding === 'base64' && typeof body.content === 'string') {
    return { sha: body.sha, content: Buffer.from(body.content, 'base64') };
  }
  if (body.download_url) {
    const dl = await fetch(body.download_url, { headers: { Authorization: `token ${adminToken()}` } });
    if (!dl.ok) return null;
    return { sha: body.sha, content: Buffer.from(await dl.arrayBuffer()) };
  }
  return { sha: body.sha, content: Buffer.alloc(0) };
};

/**
 * Obtiene el sha de un archivo en una ref dada sin descargar el contenido.
 * Útil para construir `shaIfUpdate` / `shaIfDelete` al hacer revert.
 */
export const getFileShaAtRef = async (
  repoFullName: string,
  path: string,
  ref: string
): Promise<string | null> => {
  const url = `${apiUrl()}/api/v1/repos/${repoFullName}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`;
  const r = await fetch(url, { headers: adminHeaders() });
  if (!r.ok) return null;
  const body = (await r.json()) as { sha?: string };
  return typeof body?.sha === 'string' ? body.sha : null;
};

export const createBranch = async (
  repoFullName: string,
  newBranchName: string,
  fromSha: string
): Promise<{ ok: boolean; status: number; htmlUrl?: string; error?: string }> => {
  const url = `${apiUrl()}/api/v1/repos/${repoFullName}/branches`;
  const r = await fetch(url, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ new_branch_name: newBranchName, old_ref_name: fromSha })
  });
  if (r.status === 201) {
    const body = (await r.json()) as { commit?: { url?: string } };
    return { ok: true, status: 201, htmlUrl: body?.commit?.url };
  }
  const txt = await r.text();
  return { ok: false, status: r.status, error: txt.slice(0, 200) };
};

export interface RevertResult {
  ok: boolean;
  newSha?: string;
  message?: string;
  filesChanged?: number;
  conflicts?: string[];
  error?: string;
}

/**
 * Revierte un commit aplicando los cambios inversos como un commit nuevo
 * en la rama dada (default `main`).
 *
 * Estrategia:
 * 1. Toma el commit `sha` y su parent `sha^`.
 * 2. Pide a Forgejo el diff `sha^...sha` con `compareRefs` para saber
 *    qué archivos cambiaron y en qué dirección.
 * 3. Para cada archivo:
 *    - status `added` en `sha`  → en `sha^` no existe → operación `delete`
 *      con el sha actual (HEAD) del archivo.
 *    - status `removed` en `sha` → existía en `sha^` → operación
 *      `create` con el contenido de `sha^`.
 *    - status `modified` o `renamed` → operación `update` con el
 *      contenido de `sha^` y el sha actual (HEAD) del archivo.
 * 4. Aplica todo con `applyCommit` (1 commit atómico).
 *
 * Conflictos: si entre `sha` y HEAD un archivo cambió, el sha actual
 * será distinto al esperado y Forgejo rechazará el update con 422. En
 * ese caso retornamos `conflicts: [path]`.
 */
export const revertCommitViaApi = async (params: {
  repoFullName: string;
  sha: string;
  branch?: string;
  authorName?: string;
  authorEmail?: string;
}): Promise<RevertResult> => {
  const branch = params.branch ?? 'main';
  const target = await getCommitWithParents(params.repoFullName, params.sha);
  if (!target) return { ok: false, error: `Commit ${params.sha} no existe` };
  const parentSha = target.parents?.[0]?.sha;
  if (!parentSha) return { ok: false, error: 'No se puede revertir el commit inicial (sin parent)' };

  const diff = await compareRefs(params.repoFullName, parentSha, params.sha);
  if (!diff) return { ok: false, error: 'No se pudo obtener el diff del commit' };

  const changes: CommitChange[] = [];
  const conflicts: string[] = [];

  for (const f of diff.files) {
    if (f.status === 'added') {
      // El archivo NO existía en sha^, ahora existe → revert lo borra.
      const headSha = await getFileShaAtRef(params.repoFullName, f.path, branch);
      if (!headSha) {
        // Ya fue borrado por otro commit → no hay nada que revertir.
        continue;
      }
      changes.push({ path: f.path, operation: 'delete', shaIfDelete: headSha });
    } else if (f.status === 'removed') {
      // Existía en sha^, ya no en sha → revert lo recrea.
      const original = await getFileContentAtRef(params.repoFullName, f.path, parentSha);
      if (!original) {
        conflicts.push(f.path);
        continue;
      }
      // Si por alguna razón el archivo ya volvió a existir (otro user lo
      // recreó), no podemos crear duplicado: sería conflict.
      const headSha = await getFileShaAtRef(params.repoFullName, f.path, branch);
      if (headSha) {
        // Ya existe en HEAD → operación update para sobrescribirlo.
        changes.push({
          path: f.path,
          operation: 'update',
          content: original.content,
          shaIfUpdate: headSha
        });
      } else {
        changes.push({
          path: f.path,
          operation: 'create',
          content: original.content
        });
      }
    } else {
      // modified o renamed → restaurar el contenido de sha^.
      const original = await getFileContentAtRef(params.repoFullName, f.path, parentSha);
      const headSha = await getFileShaAtRef(params.repoFullName, f.path, branch);
      if (!original || !headSha) {
        conflicts.push(f.path);
        continue;
      }
      changes.push({
        path: f.path,
        operation: 'update',
        content: original.content,
        shaIfUpdate: headSha
      });
    }
  }

  if (changes.length === 0 && conflicts.length === 0) {
    return { ok: false, error: 'Nada que revertir' };
  }
  if (changes.length === 0) {
    return { ok: false, conflicts, error: 'Conflictos en todos los archivos' };
  }

  const headerLine = (target.commit.message ?? '').split('\n')[0]?.slice(0, 60) ?? params.sha;
  const message = `Revert "${headerLine}"\n\nThis reverts commit ${params.sha}.`;

  const res = await applyCommit({
    repoFullName: params.repoFullName,
    branch,
    message,
    changes,
    ...(params.authorName ? { authorName: params.authorName } : {}),
    ...(params.authorEmail ? { authorEmail: params.authorEmail } : {}),
    abortOnChunkFailure: true
  });

  if (!res.ok) {
    const conflict422 = res.errors.filter((e) => e.status === 422).map((e) => e.path);
    return {
      ok: false,
      conflicts: [...conflicts, ...conflict422],
      error: res.errors[0]?.raw ?? 'Revert falló'
    };
  }

  return {
    ok: true,
    newSha: res.newSha,
    message,
    filesChanged: changes.length,
    ...(conflicts.length > 0 ? { conflicts } : {})
  };
};
