# Inventario de rutas bare deprecadas — sunset 2026-08-01

Las rutas "bare" son duplicados automáticos de cada ruta en `app/api/` generados
por `src/routes/nextApiRouter.ts`. Para cada ruta `/api/<path>` el router
también registra `/<path>` (sin el prefijo `/api`). Las rutas bare devuelven
los headers `Deprecation: true`, `Sunset: 2026-08-01` y
`Link: </api/...>; rel="canonical"`.

Variable de entorno de control: `BARE_API_ROUTES_SUNSET` (default `2026-08-01`).

---

## Estado del frontend (hallazgo clave)

`AgoraFront/src/services/apiClient.ts` — función `apiUrl` — solo redirige al
backend rutas que comienzan con `/api/`. Todos los call sites en AgoraFront,
AgoraCli y AgoraBack usan `/api/*` exclusivamente. **Ningún cliente conocido
llama a una ruta bare.** Por tanto todas las rutas bare son candidatas a
borrado inmediato una vez se supere el sunset.

---

## Tabla de rutas (83 rutas bare)

| # | Bare | Canónica | Frontend usa bare | Frontend usa canónica | Estado |
|---|------|----------|-------------------|-----------------------|--------|
| 1 | /admin/activate-subscription | /api/admin/activate-subscription | No | No (solo back/admin) | Lista para borrar |
| 2 | /admin/citations/backfill | /api/admin/citations/backfill | No | Sí (CitationGraphView.tsx) | Lista para borrar |
| 3 | /agora-ai/chats/:id/messages | /api/agora-ai/chats/:id/messages | No | Sí (agentChatApi.ts) | Lista para borrar |
| 4 | /agora-ai/chats/:id | /api/agora-ai/chats/:id | No | Sí (agentChatApi.ts) | Lista para borrar |
| 5 | /agora-ai/chats | /api/agora-ai/chats | No | Sí (agentChatApi.ts) | Lista para borrar |
| 6 | /agora-ai/context | /api/agora-ai/context | No | No (interno/herramienta) | Lista para borrar |
| 7 | /agora-ai/internal/execute-tool | /api/agora-ai/internal/execute-tool | No | No (compatibilidad interna) | Lista para borrar |
| 8 | /agora-ai/keys/:provider | /api/agora-ai/keys/:provider | No | Sí (agentKeysApi.ts) | Lista para borrar |
| 9 | /agora-ai/keys | /api/agora-ai/keys | No | Sí (agentKeysApi.ts) | Lista para borrar |
| 10 | /agora-ai/models | /api/agora-ai/models | No | Sí (modelCatalog.ts) | Lista para borrar |
| 11 | /agora-ai | /api/agora-ai | No | No | Lista para borrar |
| 12 | /agora-ai/stream | /api/agora-ai/stream | No | Sí (AgoraAIChat.tsx) | Lista para borrar |
| 13 | /agora-ai/tools | /api/agora-ai/tools | No | Sí (AgoraAIChat.tsx) | Lista para borrar |
| 14 | /auth/change-password | /api/auth/change-password | No | Sí (AuthContext.tsx) | Lista para borrar |
| 15 | /auth/login | /api/auth/login | No | Sí (AuthContext.tsx) | Lista para borrar |
| 16 | /auth/prepare-reset | /api/auth/prepare-reset | No | Sí (AuthContext.tsx) | Lista para borrar |
| 17 | /auth/register | /api/auth/register | No | Sí (AuthContext.tsx) | Lista para borrar |
| 18 | /auth | /api/auth | No | Sí (useOfflineSync.ts — HEAD) | Lista para borrar |
| 19 | /boards | /api/boards | No | Sí (boardApi.ts) | Lista para borrar |
| 20 | /cron/backfill-citations | /api/cron/backfill-citations | No | No (Cloud Scheduler) | Lista para borrar |
| 21 | /cron/check-subscriptions | /api/cron/check-subscriptions | No | No (Cloud Scheduler) | Lista para borrar |
| 22 | /cron/compact-sync-events | /api/cron/compact-sync-events | No | No (Cloud Scheduler) | Lista para borrar |
| 23 | /cron/drain-outbox | /api/cron/drain-outbox | No | No (Cloud Scheduler) | Lista para borrar |
| 24 | /diag/inspect-doc | /api/diag/inspect-doc | No | No | Lista para borrar |
| 25 | /diag | /api/diag | No | No (AgoraFront tiene su propio /api/diag) | Lista para borrar |
| 26 | /diag/sync-test | /api/diag/sync-test | No | No | Lista para borrar |
| 27 | /documents/:id/raw | /api/documents/:id/raw | No | Sí (OutlineView.tsx, dashboardApi.ts) | Lista para borrar |
| 28 | /documents/:id | /api/documents/:id | No | Sí (offlineSync.ts, dashboardApi.ts) | Lista para borrar |
| 29 | /documents/:id/stream | /api/documents/:id/stream | No | No (reservado) | Lista para borrar |
| 30 | /documents/:id/upload-url | /api/documents/:id/upload-url | No | Sí (dashboardApi.ts) | Lista para borrar |
| 31 | /documents/backfill-searchable | /api/documents/backfill-searchable | No | No (admin one-shot) | Lista para borrar |
| 32 | /documents/convert | /api/documents/convert | No | Sí (dashboardApi.ts) | Lista para borrar |
| 33 | /documents | /api/documents | No | Sí (offlineSync.ts, page.tsx) | Lista para borrar |
| 34 | /formalize-llm | /api/formalize-llm | No | Sí (FormalizerPlayground.tsx) | Lista para borrar |
| 35 | /git/import | /api/git/import | No | Sí (SettingsModal.tsx) | Lista para borrar |
| 36 | /git/me | /api/git/me | No | Sí (SettingsModal.tsx) | Lista para borrar |
| 37 | /payments/callback/failure | /api/payments/callback/failure | No | No (MercadoPago redirect) | Lista para borrar |
| 38 | /payments/callback/pending | /api/payments/callback/pending | No | No (MercadoPago redirect) | Lista para borrar |
| 39 | /payments/callback/success | /api/payments/callback/success | No | No (MercadoPago redirect) | Lista para borrar |
| 40 | /payments/create-preference | /api/payments/create-preference | No | Sí (PricingModal.tsx, subscriptionApi.ts) | Lista para borrar |
| 41 | /payments/storage-usage | /api/payments/storage-usage | No | Sí (UserMenu.tsx, WelcomeView.tsx, subscriptionApi.ts) | Lista para borrar |
| 42 | /payments/subscription-status | /api/payments/subscription-status | No | Sí (subscriptionApi.ts) | Lista para borrar |
| 43 | /payments/verify | /api/payments/verify | No | Sí (subscriptionApi.ts) | Lista para borrar |
| 44 | /payments/webhook | /api/payments/webhook | No | No (MercadoPago webhook externo) | Lista para borrar* |
| 45 | /search/semantic | /api/search/semantic | No | Sí (searchApi.ts) | Lista para borrar |
| 46 | /semantic | /api/semantic | No | Sí (semanticStateApi.ts) | Lista para borrar |
| 47 | /snippets/:id | /api/snippets/:id | No | Sí (snippetApi.ts) | Lista para borrar |
| 48 | /snippets | /api/snippets | No | Sí (snippetApi.ts) | Lista para borrar |
| 49 | /sync/commit | /api/sync/commit | No | No (worker/daemon) | Lista para borrar** |
| 50 | /sync/manifest | /api/sync/manifest | No | Sí (FilePropertiesModal.tsx) | Lista para borrar |
| 51 | /sync/signed-url | /api/sync/signed-url | No | Sí (GitWorkbench.tsx) | Lista para borrar |
| 52 | /sync/worker-commit | /api/sync/worker-commit | No | No (worker HMAC) | Lista para borrar** |
| 53 | /sync/worker-delete | /api/sync/worker-delete | No | No (worker HMAC) | Lista para borrar** |
| 54 | /sync/worker-fetch | /api/sync/worker-fetch | No | No (worker HMAC) | Lista para borrar** |
| 55 | /sync/worker-list | /api/sync/worker-list | No | No (worker HMAC) | Lista para borrar** |
| 56 | /sync/worker-upload-url | /api/sync/worker-upload-url | No | No (worker HMAC) | Lista para borrar** |
| 57 | /test-firestore | /api/test-firestore | No | No (dev/debug) | Lista para borrar |
| 58 | /upload/multipart/abort | /api/upload/multipart/abort | No | Sí (multipart-upload.ts) | Lista para borrar |
| 59 | /upload/multipart/complete | /api/upload/multipart/complete | No | Sí (multipart-upload.ts) | Lista para borrar |
| 60 | /upload/multipart/initiate | /api/upload/multipart/initiate | No | Sí (multipart-upload.ts) | Lista para borrar |
| 61 | /upload/multipart/sign-part | /api/upload/multipart/sign-part | No | Sí (multipart-upload.ts) | Lista para borrar |
| 62 | /upload/register | /api/upload/register | No | Sí (dashboardApi.ts, useDashboardUploads.ts) | Lista para borrar |
| 63 | /upload | /api/upload | No | No | Lista para borrar |
| 64 | /upload/signed-url | /api/upload/signed-url | No | Sí (dashboardApi.ts, useDashboardUploads.ts) | Lista para borrar |
| 65 | /users/lookup | /api/users/lookup | No | Sí (dashboardApi.ts) | Lista para borrar |
| 66 | /users/me | /api/users/me | No | Sí (dashboardApi.ts, AgoraCli) | Lista para borrar |
| 67 | /workspaces/:id/citation-graph | /api/workspaces/:id/citation-graph | No | Sí (CitationGraphView.tsx) | Lista para borrar |
| 68 | /workspaces/:id/git-info | /api/workspaces/:id/git-info | No | Sí (GitWorkbench.tsx, AgoraCli) | Lista para borrar |
| 69 | /workspaces/:id/git/checkout | /api/workspaces/:id/git/checkout | No | Sí (GitCommitDetail.tsx) | Lista para borrar |
| 70 | /workspaces/:id/git/commit | /api/workspaces/:id/git/commit | No | No (reservado) | Lista para borrar |
| 71 | /workspaces/:id/git/diff | /api/workspaces/:id/git/diff | No | No | Lista para borrar |
| 72 | /workspaces/:id/git/graph | /api/workspaces/:id/git/graph | No | No | Lista para borrar |
| 73 | /workspaces/:id/git/issue-token | /api/workspaces/:id/git/issue-token | No | Sí (GitWorkbench.tsx) | Lista para borrar |
| 74 | /workspaces/:id/git/log | /api/workspaces/:id/git/log | No | No | Lista para borrar |
| 75 | /workspaces/:id/git/persist-commit | /api/workspaces/:id/git/persist-commit | No | Sí (GitWorkbench.tsx) | Lista para borrar |
| 76 | /workspaces/:id/git/revert | /api/workspaces/:id/git/revert | No | Sí (GitCommitDetail.tsx) | Lista para borrar |
| 77 | /workspaces/:id/git/status | /api/workspaces/:id/git/status | No | No | Lista para borrar |
| 78 | /workspaces/:id/provision-git | /api/workspaces/:id/provision-git | No | Sí (GitWorkbench.tsx, AgoraCli) | Lista para borrar |
| 79 | /workspaces/:id/remotes/:remoteId/pull | /api/workspaces/:id/remotes/:remoteId/pull | No | Sí (remotesApi.ts) | Lista para borrar |
| 80 | /workspaces/:id/remotes/:remoteId/push | /api/workspaces/:id/remotes/:remoteId/push | No | Sí (remotesApi.ts) | Lista para borrar |
| 81 | /workspaces/:id/remotes/:remoteId | /api/workspaces/:id/remotes/:remoteId | No | Sí (remotesApi.ts) | Lista para borrar |
| 82 | /workspaces/:id/remotes | /api/workspaces/:id/remotes | No | Sí (remotesApi.ts) | Lista para borrar |
| 83 | /workspaces/:id | /api/workspaces/:id | No | Sí (dashboardApi.ts) | Lista para borrar |
| 84 | /workspaces | /api/workspaces | No | Sí (dashboardApi.ts, AgoraCli) | Lista para borrar |

> *`/payments/webhook` — MercadoPago envía a la URL configurada en su panel.
> Antes del borrado, confirmar que el webhook apunta a `/api/payments/webhook`.
>
> **`/sync/worker-*` y `/sync/commit` — usados por `agora-host-sync` daemon
> y workers Docker. Los workers llaman a AgoraBack directamente con la URL
> completa (`NEXUS_URL` o `NEXT_PUBLIC_API_BASE_URL`). Verificar que el daemon
> y los workers usan la URL base correcta antes de borrar.

---

## Notas de implementación

El mecanismo está en `src/routes/nextApiRouter.ts` (función
`mountNextStyleApiRoutes`). Para cada ruta, si `computeBareApiPath(entry.path)`
difiere de `entry.path`, se registra la ruta bare con `wrapHandler(handler,
{ canonicalPath: entry.path })`. La eliminación requiere simplemente no
registrar la ruta bare, es decir, borrar el bloque `if (barePath !== entry.path)`
(líneas 53-57).

---

## Resumen ejecutivo

| Categoría | Cantidad |
|-----------|----------|
| Total rutas bare | 84 |
| Listas para borrar post-sunset (sin migración previa) | 82 |
| Requieren verificación extra antes de borrar | 2 |

**Las 2 que requieren verificación extra antes del borrado:**

1. `/payments/webhook` — confirmar URL en panel MercadoPago apunta a
   `/api/payments/webhook` (no a la bare `/payments/webhook`).
2. `/sync/worker-*` (6 rutas) — confirmar que el daemon `agora-host-sync` y
   los workers Docker usan la URL completa con prefijo `/api/`. Si usan la
   bare, hay que actualizar la configuración del daemon antes del sunset.

---

## Plan de remoción (post 2026-08-01)

### Paso 1 — Verificación pre-removal (1h antes del borrado)
```bash
# 1. Confirmar URL webhook MercadoPago en el panel de MP
# 2. Verificar que el daemon usa /api/ prefix
ssh nas ssh humanizar2 'grep -r "BACKEND_URL\|API_URL\|/sync/worker\|/sync/commit" /home/humanizar/agora-host-sync/ 2>/dev/null | head -20'
# 3. Verificar workers
ssh nas ssh humanizar2 'docker inspect edu-worker-$(docker ps --filter name=edu-worker -q | head -1) | python3 -m json.tool | grep -A2 "NEXUS_URL\|API_BASE"'
```

### Paso 2 — Borrado del bloque de registro bare
En `src/routes/nextApiRouter.ts`, eliminar las líneas 53-57:
```typescript
// BORRAR este bloque:
const barePath = computeBareApiPath(entry.path);
if (barePath !== entry.path) {
  app[method.toLowerCase() as Lowercase<HttpMethod>](barePath, wrapHandler(handler, {
    canonicalPath: entry.path
  }));
}
```
También se puede borrar `getBareApiRouteDeprecationHeaders` y
`computeBareApiPath` si ya no se usan en ningún otro lugar.

### Paso 3 — Deploy y verificación
```bash
cd AgoraBack
npm run typecheck && gcloud run deploy agora-backend --source . --region us-central1
curl -I https://agora-backend-578238159459.us-central1.run.app/auth/login
# Debe responder 404, no 200/deprecated
curl -I https://agora-backend-578238159459.us-central1.run.app/api/auth/login
# Debe responder 200
```

### Paso 4 — Limpieza de código auxiliar
Una vez confirmado en producción, borrar las funciones
`getBareApiRouteDeprecationHeaders` y `computeBareApiPath` exportadas.
