# Endpoints UI git (sub-proyecto C)

Fecha: 2026-05-04
Rama: `feature/git-ui-tools`

## Contexto

El frontend de Agora muestra hoy una lista plana de commits (sha + autor +
mensaje + fecha) y nada más. Para soportar la vista enriquecida (gitgraph,
diff entre commits, revertir, checkout) se agregan endpoints REST en
AgoraBack que envuelven la API de Forgejo. Todos los handlers nuevos viven
en archivos nuevos para evitar choques con la rama `feature/atomic-commits`,
que toca `git/log/route.ts` y `git/commit/route.ts`.

## Endpoints

### 1. `GET /api/workspaces/[id]/git/diff?base=<sha>&head=<sha>`

Devuelve un diff unificado entre dos commits.

Query params:
- `base` (requerido) — sha del commit base (típicamente padre).
- `head` (requerido) — sha del commit destino.

Forgejo API que envuelve: `GET /api/v1/repos/{owner}/{repo}/compare/{base}...{head}.diff`
y `GET /api/v1/repos/{owner}/{repo}/compare/{base}...{head}` (json con metadata).

Validaciones:
- `base` y `head` matchean `^[a-f0-9]{4,40}$`.
- ACL: el usuario es miembro o owner del workspace.
- Si Forgejo no está configurado → 503.

Respuesta (200):
```ts
{
  base: string;
  head: string;
  files: Array<{
    path: string;
    oldPath?: string;        // si renombrado
    status: 'added' | 'removed' | 'modified' | 'renamed';
    additions: number;
    deletions: number;
    patch: string;           // diff unificado de ese archivo
  }>;
  stats: { totalAdditions: number; totalDeletions: number; totalFiles: number };
  truncated: boolean;        // si el diff fue truncado por tamaño
}
```

Errores: 400 (params inválidos), 401, 403, 404 (sha no existe), 503.

### 2. `POST /api/workspaces/[id]/git/revert`

Body: `{ sha: string }`.

Operación: lee el diff de `sha^` vs `sha` desde Forgejo, invierte cada
cambio (añadido se borra, borrado se reescribe con el contenido de `sha^`,
modificado se reescribe con el contenido de `sha^`) y aplica todo como un
único commit nuevo en `main` con `applyCommit` de `forgejo-git.ts`.

Mensaje del commit generado: `Revert "<mensaje original>"\n\nThis reverts commit <sha>.`

Validaciones:
- `sha` matchea `^[a-f0-9]{4,40}$`.
- ACL workspace.
- El commit existe y tiene padre (revertir el initial commit no se permite —
  retorna 422).

Respuesta (200):
```ts
{
  ok: true;
  newSha: string;
  message: string;
  filesChanged: number;
}
```

Si Forgejo retorna conflict (ej. el archivo cambió después), retornamos
`{ ok: false, error: '...', conflicts: [path...] }` con status 409.

**Consistencia con Firestore**: el revert produce un commit nuevo que el
proceso normal de sync (daemon `agora-host-sync`) detecta vía pull en el
worker. Adicionalmente, este endpoint emite un ping RTDB
`sync-events/<wsId>` con `type='git-revert'` y `meta.sha=<newSha>` para que
las hojas (clientes web + worker) sepan que algo cambió y refresquen
estado. La actualización del campo `git.lastSha` en cada documento
Firestore queda como **best-effort**: el endpoint dispara el sync pero no
espera por él. Riesgo: hasta que el worker procese el pull, los hashes en
Firestore quedan desactualizados (el status mostrará `modified` cuando en
realidad ya están "limpios" en el repo). Mitigación: el botón "Refrescar"
en GitWorkbench fuerza re-cómputo, y un ciclo del daemon (5s) corrige.

### 3. `POST /api/workspaces/[id]/git/checkout`

Body:
```ts
{ sha: string; mode: 'detached' | 'newBranch'; branchName?: string }
```

Forgejo no soporta "checkout" como operación porque el repo es bare en el
servidor; el equivalente API es:

- `mode: 'newBranch'` → `POST /api/v1/repos/{owner}/{repo}/branches`
  con `{ new_branch_name, old_ref_name: <sha> }`. Crea una rama nueva
  apuntando a ese sha.
- `mode: 'detached'` → no muta el repo. El endpoint solo valida que el
  sha existe y devuelve metadata para que la UI muestre los archivos
  "como estaban en ese sha" (lectura). El listado de archivos a ese ref
  se hace con `listRepoTree(repoFullName, sha)`.

Validaciones:
- `sha` válido.
- `branchName` (si `mode='newBranch'`) matchea `^[A-Za-z0-9_./-]{1,200}$`
  y no es `main`.
- ACL workspace.

Respuesta:
- `newBranch` (201): `{ ok: true, branch: string, sha: string, htmlUrl: string }`.
- `detached` (200): `{ ok: true, sha: string, treeSize: number, files: string[] }`.

### 4. `GET /api/workspaces/[id]/git/graph?limit=N`

Devuelve commits enriquecidos con parents + refs (branches/tags).

Forgejo:
- `GET /commits?limit=N&stat=false&verification=false` — lista commits con
  `parents` (array de objetos `{sha, url}`).
- `GET /branches` — lista de branches (cada una con `{name, commit:{id}}`).
- `GET /tags` — lista de tags.

Construimos un mapa `sha → refs[]` con branches y tags y lo inlinemos en
cada commit cuando coincide.

Respuesta (200):
```ts
{
  repoFullName: string;
  defaultBranch: string;
  commits: Array<{
    sha: string;
    shortSha: string;
    parents: string[];           // shas de parents
    message: string;
    authorName: string;
    authorEmail: string;
    date: string;
    htmlUrl: string;
    refs: string[];              // ['main', 'tag:v1.0', ...]
  }>;
}
```

## Auth y ACL

Todos los endpoints copian el patrón de `git/log/route.ts`:
- `requireAuth(req)` → uid.
- Si `!isPersonalWorkspaceId(workspaceId)`, leer doc `workspaces/<id>` y
  validar `members` o `ownerId === uid` (o `isWorkspaceMember`).
- Personal: `ownerUid = auth.uid` directamente.

Para no duplicar código, extraemos el bloque a un helper
`src/lib/git-route-acl.ts` con la firma:

```ts
export async function authorizeGitRoute(
  req: NextRequest,
  workspaceId: string
): Promise<
  | { ok: true; auth: { uid: string }; ownerUid: string; repoFullName: string }
  | { ok: false; status: number; error: string }
>;
```

## Helpers nuevos en `forgejo-history.ts`

- `listBranches(repoFullName)`
- `listTags(repoFullName)`
- `getCommitWithParents(repoFullName, sha)` — incluye `parents`.
- `compareRefs(repoFullName, base, head)` — devuelve `{ files, stats }`.
- `getFileContentAtRef(repoFullName, path, ref)` — descarga contenido del
  archivo en un sha específico.
- `createBranch(repoFullName, branchName, fromSha)`.
- `revertCommitViaApi(repoFullName, sha, opts)` — orquesta lectura del
  diff + lectura de contenidos en `sha^` + `applyCommit`.

Ninguno toca `git/log` ni `git/commit/route.ts`.

## Tests

Vitest no se usa en AgoraBack: `node:test`. Se agregan en `tests/`:
- `tests/git-revert-helper.test.ts` — unit del builder de cambios inversos
  para `revertCommitViaApi` (mockear `compareRefs` + `getFileContentAtRef`).
- `tests/git-acl-helper.test.ts` — unit de `authorizeGitRoute` con stubs
  de Firestore.
- `tests/git-graph-route-shape.test.ts` — verifica que el response shape
  declarado matchea un fixture típico (no llama Forgejo, mockea).

## Riesgos

1. **Revert de commit con conflictos** (commits posteriores tocaron las
   mismas líneas): el endpoint no resuelve. Retorna 409 con detalle.
2. **Revert + Firestore drift**: documentado arriba. Mejora futura: tras
   el revert, el endpoint puede recalcular `committedHash` de cada doc
   afectado leyendo el blob desde MinIO y compararlo con el contenido en
   `newSha`. Out of scope para este PR.
3. **Forgejo `compare.diff` puede ser 5-50 MB** en commits grandes. Se
   trunca el patch a 1MB por archivo en respuesta para no saturar la
   función Vercel (`maxDuration=60`).
