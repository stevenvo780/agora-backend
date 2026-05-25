/**
 * Convención de paths git: el repo Forgejo del workspace solo contiene los
 * archivos del workspace, sin el prefijo `users/<uid>/` o `workspaces/<wsId>/`.
 *
 * MinIO storagePath: `workspaces/<wsId>/<folder>/<name>` o `users/<uid>/<folder>/<name>`.
 * Forgejo repoPath:  `<folder>/<name>`. Folder vacío → archivo cuelga de la raíz.
 *
 * El path se sanitiza igual que el blob en MinIO (`sanitizeFileName` reemplaza
 * separadores por `_`) para que repoPath y storagePath coincidan, y para evitar
 * path-traversal (`../escape.md`, `/etc/passwd`) en docs corruptos de Firestore.
 */

const sanitizeSegment = (value: string): string =>
  value
    .trim()
    .replace(/[\\/]/g, '_') // separadores → `_` (consistente con MinIO sanitizeFileName)
    .replace(/^\.+$/, '_'); // segmentos `.` o `..` puros → `_` (no escapan)

const sanitizeFolder = (folder: unknown): string => {
  if (typeof folder !== 'string' || !folder.trim()) return '';
  return folder
    .split('/')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => part.replace(/^\.+$/, '_')) // `..` puro por segmento → `_`
    .join('/');
};

export const buildRepoPath = (folder: unknown, name: unknown): string => {
  const folderStr = sanitizeFolder(folder);
  const f = folderStr ? `${folderStr}/` : '';
  const rawName = typeof name === 'string' && name.trim() ? name.trim() : 'untitled';
  const n = sanitizeSegment(rawName) || 'untitled';
  return `${f}${n}`;
};
