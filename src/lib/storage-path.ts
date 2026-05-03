import path from 'path';
import { normalizeFolderPath } from '@/lib/folder-utils';
import { isPersonalWorkspaceId } from '@/types/workspace';

const SAFE_NAME_REGEX = /[\\/]/g;

/** Extensions that are NOT markdown and should keep their original extension in Storage. */
const NON_MARKDOWN_TEXT_EXTS = new Set([
  '.st', '.json', '.xml', '.yaml', '.yml', '.toml', '.csv',
  '.html', '.css', '.scss', '.less', '.ini', '.log', '.txt'
]);

export const sanitizeFileName = (value: string) => value.replace(SAFE_NAME_REGEX, '_');

export const ensureMarkdownFileName = (value: string) => {
  const safe = sanitizeFileName(value || 'Sin titulo');
  return safe.toLowerCase().endsWith('.md') ? safe : `${safe}.md`;
};

/**
 * Determine the correct storage filename for a text document.
 * - Markdown files: ensure .md extension
 * - Other text files (.st, .json, etc.): keep original extension
 * - No extension: default to .md
 */
export const ensureTextFileName = (value: string) => {
  const safe = sanitizeFileName(value || 'Sin titulo');
  const lower = safe.toLowerCase();
  // Already .md → keep as-is
  if (lower.endsWith('.md')) return safe;
  // Dotfiles (.gitignore, .env, .editorconfig...) — el nombre ES el archivo;
  // no agregar .md ni tratarlos como extensiones desconocidas.
  if (safe.startsWith('.') && safe.indexOf('.', 1) === -1) return safe;
  // Known non-markdown text extension → keep as-is
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx >= 0) {
    const ext = lower.slice(dotIdx);
    if (NON_MARKDOWN_TEXT_EXTS.has(ext)) return safe;
  }
  // No extension or unknown → add .md
  return `${safe}.md`;
};

export const buildStoragePrefix = (workspaceId: string, ownerId: string) => {
  return isPersonalWorkspaceId(workspaceId) ? `users/${ownerId}` : `workspaces/${workspaceId}`;
};

export const buildStoragePath = (params: {
  workspaceId: string;
  ownerId: string;
  folder?: string | null;
  fileName: string;
}) => {
  const prefix = buildStoragePrefix(params.workspaceId, params.ownerId);
  const folder = normalizeFolderPath(params.folder ?? undefined);
  return `${prefix}/${folder}/${params.fileName}`;
};

export const getStorageBaseName = (storagePath: string) => {
  return path.posix.basename(storagePath);
};
