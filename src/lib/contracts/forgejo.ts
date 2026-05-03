/**
 * Parsers de responses Forgejo. Históricamente:
 *  - listRepoTree silentemente truncaba (commit cc0e919) por mal shape.
 *  - GitWorkbench reintentaba con sha errado (db0a123) por leer body
 *    asumiendo shape específico.
 *  - Token issuance leía `body.sha1` sin verificar tipo.
 */
import { err, fieldErr, isNumber, isObject, isString, ok, type ParseResult } from './result';

export interface ForgejoTokenResponse {
  sha1: string;
}

export const parseForgejoTokenResponse = (raw: unknown): ParseResult<ForgejoTokenResponse> => {
  if (!isObject(raw)) return err('token response is not an object');
  if (!isString(raw.sha1) || !raw.sha1) return fieldErr('sha1', 'non-empty string', raw.sha1);
  return ok({ sha1: raw.sha1 });
};

export interface ForgejoCommitResponse {
  sha: string;
}

export const parseForgejoCommitResponse = (raw: unknown): ParseResult<ForgejoCommitResponse> => {
  if (!isObject(raw)) return err('commit response is not an object');
  const commit = raw.commit;
  if (!isObject(commit)) return fieldErr('commit', 'object', commit);
  if (!isString(commit.sha) || !commit.sha) return fieldErr('commit.sha', 'non-empty string', commit.sha);
  return ok({ sha: commit.sha });
};

export interface ForgejoTreeEntry {
  path: string;
  sha: string;
  type: string;
}

export interface ForgejoTreeResponse {
  entries: ForgejoTreeEntry[];
  truncated: boolean;
}

export const parseForgejoTreeResponse = (raw: unknown): ParseResult<ForgejoTreeResponse> => {
  if (!isObject(raw)) return err('tree response is not an object');
  const tree = raw.tree;
  if (!Array.isArray(tree)) return fieldErr('tree', 'array', tree);
  const entries: ForgejoTreeEntry[] = [];
  for (let i = 0; i < tree.length; i++) {
    const entry = tree[i];
    if (!isObject(entry)) continue;
    if (!isString(entry.path) || !isString(entry.sha) || !isString(entry.type)) continue;
    entries.push({ path: entry.path, sha: entry.sha, type: entry.type });
  }
  const truncated = raw.truncated === true;
  return ok({ entries, truncated });
};

export interface ForgejoFileMeta {
  path: string;
  sha: string;
  size: number;
  type: 'file' | 'dir' | 'symlink';
  encoding: string | null;
  content: string | null;
  download_url: string | null;
}

export const parseForgejoFileMeta = (raw: unknown): ParseResult<ForgejoFileMeta> => {
  if (!isObject(raw)) return err('file meta is not an object');
  if (!isString(raw.path)) return fieldErr('path', 'string', raw.path);
  if (!isString(raw.sha)) return fieldErr('sha', 'string', raw.sha);
  const t = raw.type;
  if (t !== 'file' && t !== 'dir' && t !== 'symlink') {
    return fieldErr('type', "'file'|'dir'|'symlink'", t);
  }
  return ok({
    path: raw.path,
    sha: raw.sha,
    size: isNumber(raw.size) ? raw.size : 0,
    type: t,
    encoding: isString(raw.encoding) ? raw.encoding : null,
    content: isString(raw.content) ? raw.content : null,
    download_url: isString(raw.download_url) ? raw.download_url : null
  });
};
