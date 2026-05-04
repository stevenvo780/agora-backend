# Commits atómicos en Forgejo (sub-proyecto A)

Fecha: 2026-05-04
Rama: `feature/atomic-commits`

## Problema

Hoy `applyCommit()` en `src/lib/forgejo-git.ts` parte un commit lógico en
chunks (default 10 archivos / 30 MB) y POSTea cada chunk a
`POST /api/v1/repos/{owner}/{repo}/contents` como un commit separado, con el
mensaje `"<message> (parte i/N)"`. Resultado: un click del usuario en
"commit" puede generar N commits en Forgejo.

Consecuencias:
- Un revert por SHA solo deshace el último chunk → repo queda inconsistente
  en estado intermedio raro (parte 1/9 OK, 2/9 reverted, 3/9 OK).
- El "commit del usuario" no es una unidad lógica en el log; el gitgraph
  muestra ruido.
- Si el chunk i falla a medias y `abortOnChunkFailure=true`, los chunks
  1..i-1 ya quedaron escritos en `main` → el usuario ve un commit parcial
  con archivos faltantes.

Objetivo: 1 POST a `/api/workspaces/[id]/git/commit` ⇒ exactamente 1
commit en Forgejo, sin importar cantidad de archivos / MB.

## Investigación de la API de Forgejo

Forgejo en producción: `git.proxy.humanizar-dev.cloud`, versión
`10.0.3+gitea-1.22.0`.

### Opción A — Git API de bajo nivel (estilo GitHub)

Idea: `POST /git/blobs`, `POST /git/trees`, `POST /git/commits`,
`PATCH /git/refs/heads/main`. Permitiría construir el commit en
transacción cliente-side y solo "publicarlo" al final.

**Probado contra prod**: estos endpoints **no existen** (404 en POST/PATCH;
solo GET). Confirmado vía swagger:

```
GET    /repos/{owner}/{repo}/git/blobs/{sha}
GET    /repos/{owner}/{repo}/git/commits/{sha}
GET    /repos/{owner}/{repo}/git/refs
GET    /repos/{owner}/{repo}/git/refs/{ref}
GET    /repos/{owner}/{repo}/git/trees/{sha}
```

No hay `POST` ni `PATCH` para crear blobs/trees/commits/refs. Forgejo /
Gitea decidió no implementar la Git API low-level estilo GitHub.

**Descartada.**

### Opción B — Clonar localmente, commit, push

Ejecutar `git clone` en `/tmp`, escribir archivos, `git add . && git
commit && git push`. Atómico (1 push = 1 ref update).

Costo:
- Clone full del repo en cada commit (lento — repos pueden tener cientos
  de archivos).
- En Cloud Run el FS es efímero pero limitado (~512MB-1GB rootfs); no
  cabe un repo grande con docs binarios.
- Requiere `git` CLI en la imagen (hoy no se invoca subprocess git en
  AgoraBack).
- Latencia adicional (clone + push) y manejo de creds para el push.

**Descartada como default**, queda como fallback futuro si aparece un
límite real del endpoint `/contents`.

### Opción C — `POST /repos/{owner}/{repo}/contents` (ChangeFiles) sin chunking

El endpoint que el código ya usa, pero **sin** partirlo: enviar todos los
files en un solo POST.

Spec OpenAPI (Forgejo 10.0.3):

```
POST /repos/{owner}/{repo}/contents
body: ChangeFilesOptions {
  branch?: string,
  message?: string,
  files: ChangeFileOperation[],   // sin documented max length
  author?: Identity, committer?: Identity, dates?, signoff?, new_branch?
}
```

`ChangeFileOperation` admite `operation: create | update | delete`,
`path`, `content` (base64) y `sha` (requerido para update/delete).

**Probado contra prod** en un repo de prueba `agora/atomic-commit-test`:

| Test | Files | Body size | Resultado |
|---|---|---|---|
| 1 | 50 archivos × ~20KB | 1.3MB | HTTP 201 en 7s, **1 commit** en log |
| 2 | 200 archivos × 250KB | 68MB | HTTP 201 en 82s, **1 commit** en log |
| 3 | 1 archivo × 100MB | 134MB | HTTP 201 en 99s, **1 commit** en log |

Conclusión: `POST /contents` ya hace **1 commit transaccional** sin
importar cuántos files. El chunking actual era una precaución no
validada — agregaba el problema sin resolver ninguno real.

**Elegida.**

## Diseño elegido

### Cambio funcional

`applyCommit()` envía **un único** `POST /contents` con todos los files.
Si el servidor responde error, todo el commit falla; no hay estados
intermedios escritos.

### API de `applyCommit` — cambios

Eliminados (no aplican con 1 commit):
- `maxChunkBytes` — irrelevante.
- `maxChunkFiles` — irrelevante.
- `abortOnChunkFailure` — siempre se aborta si falla.
- `CommitChunkProgress`, `CommitRetryEvent`, eventos `chunkIndex` /
  `kind: 'retry-exhausted'`. Reemplazados por progreso simple.

`onProgress` queda con eventos:
- `{ kind: 'start', totalFiles }` — al iniciar.
- `{ kind: 'attempt', attempt, totalFiles }` — al disparar un POST.
- `{ kind: 'retry', attempt, reason, totalFiles }` — entre reintentos.
- `{ kind: 'done', sha, totalFiles }` — al completar.

`maxAttempts` (renombrado desde `maxAttemptsPerChunk`) — reintentos del
POST único; default 6, mismo backoff que antes.

`CommitResult` mantiene `{ ok, newSha, errors }`. En error, `errors` lista
los paths que el usuario quería commitear (todos, porque la operación es
all-or-nothing) con la razón.

### Caller: `git/commit/route.ts`

El handler envía SSE con eventos `progress` que ya enrutan al cliente.
Como el shape del evento cambia (sin chunkIndex), el cliente actual debe
seguir parseando el evento sin asumir esos campos. Los SSE quedan así:

- `{ event: 'progress', kind: 'start', totalFiles }` — antes era
  `{ kind: 'start', totalChunks, totalFiles }`. `totalChunks` desaparece.
- `{ event: 'progress', kind: 'attempt', attempt, totalFiles }` —
  reemplaza el evento por chunk anterior.
- `{ event: 'progress', kind: 'retry', attempt, reason, totalFiles }`.
- `{ event: 'persist', total }`, `{ event: 'persist-progress' }`,
  `{ event: 'done' }` — sin cambios.

El cliente AgoraFront usa estos eventos para mostrar barra de progreso.
Como el cambio elimina granularidad ("subiendo chunk 3/9" → "intentando
commit"), la UX queda más simple. No hay regresión funcional, sí cambia
el copy.

## Plan de implementación

1. Refactor `applyCommit()`: eliminar lógica de chunking, simplificar
   tipos de progreso, usar `callWithRetry` con un solo POST.
2. Limpiar tipos exportados no usados (`CommitChunkProgress`,
   `CommitRetryEvent`, `CommitProgress` si solo se usaba internamente).
3. Ajustar `git/commit/route.ts` al nuevo shape de eventos `onProgress`.
4. Tests unitarios con `node:test` + mock de `fetch`.

## Plan de tests

Archivo `tests/forgejo-git-atomic.test.ts` con casos:

1. `applyCommit_envia_un_solo_POST`: stub global.fetch, llamar
   `applyCommit` con 25 changes, assert que `fetch` fue invocado 1 vez,
   con method POST y `body.files.length === 25`.
2. `applyCommit_propaga_message_sin_chunk_suffix`: assert que el body
   tiene `message === params.message` (no `(parte 1/N)`).
3. `applyCommit_devuelve_sha_del_commit_creado`: stub responde 201 con
   `{ commit: { sha: 'abc123...' } }`, assert `result.newSha === 'abc123...'`.
4. `applyCommit_falla_atomico_marca_todos_los_paths`: stub responde 500
   en todos los reintentos, assert `result.ok === false` y
   `result.errors.length === changes.length` (todos los paths fallaron).
5. `applyCommit_construye_files_con_operacion_correcta`: mix de create /
   update / delete, assert el body matcheea con `sha` solo en
   update/delete y `content` solo en create/update.
6. `applyCommit_reintenta_en_5xx_y_eventualmente_acepta`: stub falla 2
   veces con 503, luego 201, assert un solo commit creado y los retries
   reportados al onProgress.

## Riesgos

- **Cambio de shape SSE**: si el cliente AgoraFront depende de
  `chunkIndex` / `totalChunks` para renderizar progreso, lo veo "Subiendo
  ... (sin progreso visible)" hasta el fin. Mitigación: el cliente debe
  manejar el evento `attempt` para mostrar "Comiteando..." sin barra. Si
  no se ajusta el cliente, no hay error, solo UX más pobre.
- **Latencia**: payloads grandes ahora corren en una sola request larga.
  Si Vercel termina la function antes de los 800s `maxDuration` actuales
  por algún motivo (proxy idle, etc.), el commit no se materializa.
  Mitigación: `callWithRetry` ya maneja network errors; si falla el
  socket en medio, el reintento debería repegar. Si Forgejo procesó el
  commit pero la respuesta no llegó, el reintento puede crear un commit
  duplicado idempotente — no es crítico (mismo árbol → no hay diff
  real, queda como commit "vacío" en el log). Aceptable.
- **Memoria peak en Cloud Run**: cargar todos los buffers + serializar a
  base64 simultáneamente sube el peak. Hoy el caller carga buffers en
  memoria con concurrencia 8 antes de invocar `applyCommit` (línea ~88
  de `git/commit/route.ts`), así que el peak ya estaba ahí — no
  empeora. La diferencia es que el JSON.stringify del body completo
  aparece de un golpe (esto sí es nuevo). Para los volúmenes observados
  hoy (~200 archivos × 250KB = 68MB body), fits cómodamente en una
  function 1GB. Si en el futuro se ven OOMs, se puede cambiar a clone
  local + push (Opción B).
- **Sin endpoint para "rollback parcial"**: antes, si fallaba el chunk
  3/9, los chunks 1-2 quedaban escritos. Ahora si falla, no hay nada
  escrito (mejor). Pero si el usuario quería "comitea lo que puedas",
  ese modo desaparece. No conozco un caller que dependa de eso —
  contrato siempre fue all-or-nothing semánticamente.
