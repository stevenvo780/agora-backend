/**
 * Convención de paths git: el repo Forgejo del workspace solo contiene los
 * archivos del workspace, sin el prefijo `users/<uid>/` o `workspaces/<wsId>/`.
 *
 * MinIO storagePath: `workspaces/<wsId>/<folder>/<name>` o `users/<uid>/<folder>/<name>`.
 * Forgejo repoPath:  `<folder>/<name>`  (folder=`No estructurado` se aplana al raíz).
 */
export const buildRepoPath = (folder: unknown, name: unknown): string => {
  const f = typeof folder === 'string' && folder !== 'No estructurado' ? `${folder}/` : '';
  const n = typeof name === 'string' && name.trim() ? name.trim() : 'untitled';
  return `${f}${n}`;
};
