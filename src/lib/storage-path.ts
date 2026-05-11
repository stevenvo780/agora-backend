import path from 'path';
import { normalizeFolderPath } from '@/lib/folder-utils';
import { isPersonalWorkspaceId } from '@/types/workspace';

const SAFE_NAME_REGEX = /[\\/]/g;

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
const VALID_EXTENSION_REGEX = /\.[a-z0-9]{1,16}$/i;

export const ensureTextFileName = (value: string) => {
  const safe = sanitizeFileName(value || 'Sin titulo');
  // Dotfiles (.gitignore, .env, .editorconfig...) — el nombre ES el archivo.
  if (safe.startsWith('.') && safe.indexOf('.', 1) === -1) return safe;
  // Cualquier extensión válida se preserva (no solo el set conocido).
  // Esto permite crear .py, .rs, .go, .ipynb, etc. sin agregar .md.
  if (VALID_EXTENSION_REGEX.test(safe)) return safe;
  // Sin extensión → default a .md (markdown es el formato base).
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
  return folder
    ? `${prefix}/${folder}/${params.fileName}`
    : `${prefix}/${params.fileName}`;
};

export const getStorageBaseName = (storagePath: string) => {
  return path.posix.basename(storagePath);
};
