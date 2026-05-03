/**
 * Forgejo content API helpers — operar el repo del workspace como un git remote.
 * No clonamos localmente: hacemos PUT/POST/DELETE sobre `/contents/{path}` y
 * `/commits` para obtener historia.
 */
import { parseForgejoCommitResponse, parseForgejoTreeResponse } from '@/lib/contracts';
import { env } from '@/lib/env';

const apiUrl = env.FORGEJO_API_URL() || undefined;
const adminToken = env.FORGEJO_ADMIN_TOKEN() || undefined;

const headers = (): HeadersInit => ({
  Accept: 'application/json',
  'Content-Type': 'application/json',
  Authorization: `token ${adminToken}`
});

// Sin timeout per-request: Forgejo procesa commits grandes lentamente y queremos
// dejarle el tiempo que necesite. Si la red corta el socket, el retry lo
// reintenta. AbortController solo si el caller lo pasa explícitamente.
const call = async <T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T | null; raw: string }> => {
  if (!apiUrl) throw new Error('FORGEJO_API_URL required');
  const res = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers ?? {}) }
  });
  const raw = await res.text();
  let body: T | null = null;
  if (raw) { try { body = JSON.parse(raw) as T; } catch { /* not json */ } }
  return { status: res.status, body, raw };
};

/** Retry con backoff para errores transitorios (network, 5xx, 429). NO reintenta 4xx no-429. */
const isRetriable = (status: number, err?: unknown): boolean => {
  if (err) return true; // network error
  if (status === 0) return true;
  if (status === 408 || status === 425 || status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
};

const callWithRetry = async <T>(
  path: string,
  init: RequestInit = {},
  opts: { maxAttempts?: number; baseDelayMs?: number; onRetry?: (attempt: number, reason: string) => void } = {}
): Promise<{ status: number; body: T | null; raw: string; attempts: number }> => {
  const maxAttempts = opts.maxAttempts ?? 6;
  const baseDelay = opts.baseDelayMs ?? 1500;
  let lastErr: unknown;
  let lastStatus = 0;
  let lastRaw = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const r = await call<T>(path, init);
      if (r.status >= 400 && isRetriable(r.status)) {
        lastStatus = r.status;
        lastRaw = r.raw;
        if (attempt < maxAttempts) {
          const delay = baseDelay * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
          opts.onRetry?.(attempt, `HTTP ${r.status}: retry in ${delay}ms`);
          await new Promise((res) => setTimeout(res, delay));
          continue;
        }
      }
      return { ...r, attempts: attempt };
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        const delay = baseDelay * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
        opts.onRetry?.(attempt, `network: ${(e as Error).message}; retry in ${delay}ms`);
        await new Promise((res) => setTimeout(res, delay));
        continue;
      }
    }
  }
  if (lastErr) throw lastErr;
  return { status: lastStatus, body: null, raw: lastRaw, attempts: maxAttempts };
};

export interface ForgejoCommitInfo {
  sha: string;
  url: string;
  html_url: string;
  created: string;
  commit: {
    message: string;
    author: { name: string; email: string; date: string };
  };
}

export interface ForgejoFileEntry {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: 'file' | 'dir' | 'symlink';
  encoding?: string;
  content?: string;
  download_url?: string;
}

export const listCommits = async (
  repoFullName: string,
  limit = 30
): Promise<ForgejoCommitInfo[]> => {
  const r = await call<ForgejoCommitInfo[]>(`/api/v1/repos/${repoFullName}/commits?limit=${limit}`);
  return Array.isArray(r.body) ? r.body : [];
};

/**
 * 1 sola llamada para obtener todo el árbol del repo (recursive).
 * Mucho más rápido que N getFileMeta() por path.
 * Returns map { repoPath -> blob sha }.
 */
export const listRepoTree = async (
  repoFullName: string,
  ref = 'HEAD'
): Promise<Map<string, string>> => {
  const commits = await call<ForgejoCommitInfo[]>(`/api/v1/repos/${repoFullName}/commits?limit=1&sha=${encodeURIComponent(ref)}`);
  const head = Array.isArray(commits.body) && commits.body[0] ? commits.body[0] : null;
  if (!head) return new Map();
  const map = new Map<string, string>();
  // Forgejo límite máximo per_page=1000 + paginación cuando hay más. Sin esto,
  // workspaces con >1000 archivos veían los excedentes como "no existe" y el
  // cliente los reportaba como `create` → 422 "file already exists".
  const PAGE_SIZE = 1000;
  let page = 1;
  while (true) {
    const r = await call<unknown>(
      `/api/v1/repos/${repoFullName}/git/trees/${head.sha}?recursive=true&per_page=${PAGE_SIZE}&page=${page}`
    );
    const parsed = parseForgejoTreeResponse(r.body);
    if (!parsed.ok) {
      console.warn('[listRepoTree] tree response malformed:', parsed.error);
      break;
    }
    const { entries, truncated } = parsed.value;
    if (entries.length === 0) break;
    for (const entry of entries) {
      if (entry.type === 'blob') map.set(entry.path, entry.sha);
    }
    if (!truncated && entries.length < PAGE_SIZE) break;
    page++;
    if (page > 100) {
      console.warn('[listRepoTree] safety stop after 100 pages — repo gigante?');
      break;
    }
  }
  return map;
};

export const getFileMeta = async (repoFullName: string, path: string): Promise<ForgejoFileEntry | null> => {
  const r = await call<ForgejoFileEntry>(`/api/v1/repos/${repoFullName}/contents/${encodeURI(path)}`);
  if (r.status !== 200 || !r.body) return null;
  return r.body;
};

export const getFileContent = async (repoFullName: string, path: string): Promise<{ sha: string; content: Buffer } | null> => {
  const meta = await getFileMeta(repoFullName, path);
  if (!meta || meta.type !== 'file') return null;
  if (meta.content && meta.encoding === 'base64') {
    return { sha: meta.sha, content: Buffer.from(meta.content, 'base64') };
  }
  if (meta.download_url) {
    const res = await fetch(meta.download_url, { headers: { Authorization: `token ${adminToken}` } });
    if (!res.ok) return null;
    return { sha: meta.sha, content: Buffer.from(await res.arrayBuffer()) };
  }
  return { sha: meta.sha, content: Buffer.alloc(0) };
};

export interface CommitFileChange {
  path: string;
  /** raw bytes — se codifica a base64 internamente. Puede ser provisto directamente
   * o cargarse lazy con `load()` (preferido para commits grandes — evita tener
   * todos los buffers en RAM al mismo tiempo y revienta a la function por OOM). */
  content?: Buffer;
  load?: () => Promise<Buffer | null>;
  /** estimación de bytes para chunking previo a load() */
  estimatedBytes?: number;
  /** undefined para files nuevos */
  shaIfUpdate?: string;
  operation: 'create' | 'update';
}

export interface CommitDeleteChange {
  path: string;
  shaIfDelete: string;
  operation: 'delete';
}

export type CommitChange = CommitFileChange | CommitDeleteChange;

export interface CommitResult {
  ok: boolean;
  newSha?: string;
  errors: { path: string; status: number; raw: string }[];
}

/**
 * Aplica los cambios en UN SOLO commit atómico usando el endpoint
 * `POST /repos/{owner}/{repo}/contents` (ChangeFiles, Forgejo/Gitea ≥1.20).
 *
 * Body: { files: [{ path, operation, content?, sha? }], message, branch, ... }
 *
 * Esto reduce N round-trips secuenciales a 1, y produce 1 commit en vez de N.
 * Si el endpoint falla por payload demasiado grande, partimos en chunks y
 * devolvemos un error multi-commit (cada chunk genera 1 commit).
 */
export interface CommitProgress {
  totalChunks: number;
  totalFiles: number;
}

export interface CommitChunkProgress extends CommitProgress {
  chunkIndex: number;
  filesInChunk: number;
  lastSha?: string;
  error?: string;
  attempts?: number;
}

export interface CommitRetryEvent extends CommitProgress {
  chunkIndex: number;
  attempt: number;
  reason: string;
}

export const applyCommit = async (params: {
  repoFullName: string;
  branch?: string;
  message: string;
  changes: CommitChange[];
  authorName?: string;
  authorEmail?: string;
  /** límite de bytes por chunk multi-file. Forgejo default body limit ~100MB. */
  maxChunkBytes?: number;
  /** límite de archivos por chunk: Forgejo escribe blobs + tree linealmente,
   * con muchos archivos por commit consume mucha RAM/CPU del peer. */
  maxChunkFiles?: number;
  /** callback opcional para emitir progreso por chunk. */
  onProgress?: (ev: CommitChunkProgress | { kind: 'start'; totalChunks: number; totalFiles: number } | CommitRetryEvent | { kind: 'retry-exhausted'; chunkIndex: number; totalChunks: number; totalFiles: number }) => void;
  /** intentos por chunk antes de marcar fallido (default 6). */
  maxAttemptsPerChunk?: number;
  /** si true, aborta los chunks restantes cuando uno falla (default true) — evita
   * commits parciales con incoherencia de orden. Si false, sigue con los siguientes. */
  abortOnChunkFailure?: boolean;
}): Promise<CommitResult> => {
  const branch = params.branch || 'main';
  const errors: { path: string; status: number; raw: string }[] = [];
  let lastSha: string | undefined;

  const author = params.authorName
    ? { author: { name: params.authorName, email: params.authorEmail ?? `${params.authorName}@noreply.agora.local` } }
    : {};

  const buildFile = (c: CommitChange, buf: Buffer | null) => {
    if (c.operation === 'delete') {
      return { path: c.path, operation: 'delete', sha: c.shaIfDelete };
    }
    return {
      path: c.path,
      operation: c.operation === 'update' ? 'update' : 'create',
      content: (buf ?? c.content ?? Buffer.alloc(0)).toString('base64'),
      ...(c.operation === 'update' && c.shaIfUpdate ? { sha: c.shaIfUpdate } : {})
    };
  };

  // Estimación segura de tamaño de un change SIN cargarlo (evita OOM por preload).
  const sizeOf = (c: CommitChange): number => {
    if (c.operation === 'delete') return 256;
    if (c.content) return Math.ceil(c.content.length * 1.4);
    if (typeof c.estimatedBytes === 'number') return Math.ceil(c.estimatedBytes * 1.4);
    return 1024 * 1024; // 1 MB heurística por defecto
  };

  // Particionar en chunks por (a) cantidad de archivos y (b) tamaño de payload.
  // CONSERVADOR por default: 10 archivos / 30 MB para mantener peak memory bajo.
  const maxBytes = params.maxChunkBytes ?? 30 * 1024 * 1024;
  const maxFiles = Math.max(1, params.maxChunkFiles ?? 10);
  const chunks: CommitChange[][] = [];
  let current: CommitChange[] = [];
  let currentSize = 0;
  for (const c of params.changes) {
    const sz = sizeOf(c);
    const wouldExceedSize = currentSize + sz > maxBytes;
    const wouldExceedCount = current.length >= maxFiles;
    if (current.length > 0 && (wouldExceedSize || wouldExceedCount)) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(c);
    currentSize += sz;
  }
  if (current.length > 0) chunks.push(current);

  params.onProgress?.({ kind: 'start', totalChunks: chunks.length, totalFiles: params.changes.length });

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const chunkIndex = i + 1;
    const message = chunks.length === 1
      ? params.message
      : `${params.message} (parte ${chunkIndex}/${chunks.length})`;

    let r: { status: number; body: unknown; raw: string; attempts: number };
    try {
      r = await callWithRetry<unknown>(
        `/api/v1/repos/${params.repoFullName}/contents`,
        {
          method: 'POST',
          body: JSON.stringify({
            files: chunk.map((c) => buildFile(c, null)),
            message,
            branch,
            ...author
          })
        },
        {
          maxAttempts: params.maxAttemptsPerChunk ?? 6,
          onRetry: (attempt, reason) => {
            params.onProgress?.({
              chunkIndex,
              totalChunks: chunks.length,
              totalFiles: params.changes.length,
              attempt,
              reason
            });
          }
        }
      );
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      r = { status: 0, body: null, raw: msg, attempts: params.maxAttemptsPerChunk ?? 6 };
    }

    let chunkErr: string | undefined;
    let chunkFailed = false;
    if (r.status >= 400 || r.status === 0) {
      chunkErr = `HTTP ${r.status} ${r.raw.slice(0, 120)}`;
      chunkFailed = true;
      for (const c of chunk) {
        errors.push({ path: c.path, status: r.status, raw: r.raw.slice(0, 200) });
      }
      params.onProgress?.({
        kind: 'retry-exhausted',
        chunkIndex,
        totalChunks: chunks.length,
        totalFiles: params.changes.length
      });
    } else {
      const parsed = parseForgejoCommitResponse(r.body);
      if (parsed.ok) lastSha = parsed.value.sha;
    }
    params.onProgress?.({
      totalChunks: chunks.length,
      totalFiles: params.changes.length,
      chunkIndex,
      filesInChunk: chunk.length,
      lastSha,
      error: chunkErr,
      attempts: r.attempts
    });

    // Default: abortar al primer chunk fallido para evitar commits parciales
    // con orden incoherente (ej. parte 1/9 OK, 2/9 falla, 3-9 OK → repo en
    // estado raro). El cliente ve qué archivos quedaron por reintentar.
    if (chunkFailed && (params.abortOnChunkFailure ?? true)) {
      const skipped = params.changes.slice(
        chunks.slice(0, i + 1).reduce((acc, c) => acc + c.length, 0)
      );
      for (const c of skipped) {
        errors.push({ path: c.path, status: 0, raw: 'skipped: aborted after previous chunk failed' });
      }
      break;
    }
  }

  return { ok: errors.length === 0, newSha: lastSha, errors };
};
