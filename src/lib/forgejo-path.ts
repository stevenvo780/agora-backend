/**
 * Convención de paths git: el repo Forgejo del workspace solo contiene los
 * archivos del workspace, sin el prefijo `users/<uid>/` o `workspaces/<wsId>/`.
 *
 * MinIO storagePath: `workspaces/<wsId>/<folder>/<name>` o `users/<uid>/<folder>/<name>`.
 * Forgejo repoPath:  `<folder>/<name>`. Folder vacío → archivo cuelga de la raíz.
 */
export const buildRepoPath = (folder: unknown, name: unknown): string => {
  const folderStr = typeof folder === 'string' ? folder.trim() : '';
  const f = folderStr ? `${folderStr}/` : '';
  const n = typeof name === 'string' && name.trim() ? name.trim() : 'untitled';
  return `${f}${n}`;
};
