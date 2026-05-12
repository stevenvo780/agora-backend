# AgoraBack — API de Agora en Cloud Run

`AgoraBack` concentra toda la API de Agora: auth custom, usuarios, workspaces,
documentos, upload/sync, Forgejo, NAS/MinIO, pagos MercadoPago, cron jobs y
Agora AI. `AgoraFront` queda como UI Next.js sin handlers `src/app/api`.

## Arquitectura

```
Browser / Vercel UI
  └─ HTTPS /api/* → Cloud Run: AgoraBack
       ├─ Firebase Admin / Firestore / RTDB
       ├─ NAS S3 / MinIO
       ├─ Forgejo
       ├─ MercadoPago webhook/callbacks
       └─ Agora AI + tools locales
```

El servidor Express monta automáticamente todos los handlers migrados desde
`src/app/api/**/route.ts` mediante `src/routes/nextApiRouter.ts`. Se sirven bajo
`/api/*` y, por compatibilidad, también sin el prefijo `/api`.

## Desarrollo

```bash
npm install
npm run dev
```

El servicio escucha en `PORT` o `8080`.

```bash
curl http://localhost:8080/health
curl -I http://localhost:8080/api/auth
```

## Build

```bash
npm run build
npm start
```

El build usa `tsc-alias` para convertir imports `@/*` a rutas ESM ejecutables en
Node.

## Variables Principales

```bash
ALLOWED_ORIGINS=https://agora.humanizar.cloud,http://localhost:3000

FIREBASE_PROJECT_ID=
FIREBASE_DATABASE_URL=
FIREBASE_SERVICE_ACCOUNT=                 # rotada 2026-05; Secret Manager v3

AGORA_USE_NAS=true
NAS_S3_ENDPOINT=
NAS_S3_BUCKET=agora-blobs
NAS_S3_ACCESS_KEY=
NAS_S3_SECRET_KEY=

FORGEJO_API_URL=
FORGEJO_ADMIN_TOKEN=
FORGEJO_ORG=agora

MERCADOPAGO_ACCESS_TOKEN=
MERCADOPAGO_WEBHOOK_SECRET=
MERCADOPAGO_SANDBOX=false

# Hub (workers Docker en humanizar2). Required: las tools del agente IA
# usan esta URL para alcanzar al worker correspondiente al workspace.
NEXUS_URL=https://hub.humanizar-dev.cloud

WORKER_SYNC_SECRET=
WORKER_SECRET=
WORKER_SECRET_PREVIOUS=
CRON_SECRET=
BACKEND_INTERNAL_SECRET=                  # fallback: HUB_INTERNAL_SECRET
ENABLE_ADMIN_ENDPOINTS=false
APP_PASSWORD=

# Rate-limit agente IA (Firestore tracking: users/{uid}/agentUsage/daily-YYYY-MM-DD)
AGORA_AI_DAILY_TOKEN_BUDGET=500000
AGORA_AI_HOURLY_MESSAGE_CAP=100
# Abuse-block tras 5×429 en 10min (hardcoded, ajustable en código si hace falta)

OPENWEBUI_ENDPOINT=
OPENWEBUI_API_KEY=
OLLAMA_ENDPOINT=http://localhost:11434/api/chat
OLLAMA_MODEL=autologic-formalizer
```

## Deploy Cloud Run

```bash
gcloud run deploy agora-backend \
  --source . \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --memory 1Gi \
  --cpu 1 \
  --timeout 3600 \
  --concurrency 40 \
  --min-instances 0 \
  --max-instances 5 \
  --set-env-vars "ALLOWED_ORIGINS=https://agora.humanizar.cloud,FIREBASE_PROJECT_ID=udea-filosofia,NEXUS_URL=https://hub.humanizar-dev.cloud"
```

> `min-instances=0` deliberado: los cold starts del agente IA se
> absorben porque el stream ya muestra "Pensando…" en el primer token.
> Esto mantiene el costo Cloud Run en free tier (<$1/mes).

Configura en `AgoraFront`:

```bash
NEXT_PUBLIC_API_BASE_URL=https://<cloud-run-service-url>
```

## Cloud Scheduler

Vercel Cron ya no se usa. Crea jobs contra Cloud Run:

```bash
gcloud scheduler jobs create http agora-check-subscriptions \
  --schedule="0 6 * * *" \
  --uri="https://<cloud-run-service-url>/api/cron/check-subscriptions" \
  --http-method=GET \
  --headers="Authorization=Bearer ${CRON_SECRET}"

gcloud scheduler jobs create http agora-drain-outbox \
  --schedule="*/5 * * * *" \
  --uri="https://<cloud-run-service-url>/api/cron/drain-outbox" \
  --http-method=GET \
  --headers="Authorization=Bearer ${CRON_SECRET}"
```

Si proteges Cloud Run con IAM, usa una service account invocadora y OIDC en los
jobs de Scheduler.

## MercadoPago

Actualiza manualmente las URLs en el dashboard de MercadoPago:

```text
Webhook:  https://<cloud-run-service-url>/api/payments/webhook
Success:  https://<cloud-run-service-url>/api/payments/callback/success
Failure:  https://<cloud-run-service-url>/api/payments/callback/failure
Pending:  https://<cloud-run-service-url>/api/payments/callback/pending
```

## Agora AI Agent

El agente IA expone **145 tools** (1 stub eliminada en 2026-05, 5
deprecated, 28 mejor documentadas) y ejecuta dentro del propio
AgoraBack con `executeAgentTool`. El endpoint
`/api/agora-ai/internal/execute-tool` queda como compatibilidad
protegida (`BACKEND_INTERNAL_SECRET`).

### Chats persistidos

```text
GET    /api/agora-ai/chats                    # lista chats del user
POST   /api/agora-ai/chats                    # crea chat
GET    /api/agora-ai/chats/:id                # detalle + mensajes
PUT    /api/agora-ai/chats/:id                # rename/archive
DELETE /api/agora-ai/chats/:id
POST   /api/agora-ai/chats/:id/messages       # append (también auto-persistido por stream)
```

Persistencia: `users/{uid}/agentChats/{chatId}` + subcollection
`messages/`.

### API keys vault (BYOK)

```text
GET    /api/agora-ai/keys                     # lista providers configurados (sin el secreto)
POST   /api/agora-ai/keys                     # guarda { provider, apiKey }
DELETE /api/agora-ai/keys/:provider
```

Cifrado AES-256-GCM con clave derivada por HKDF de `WORKER_SECRET`.
Guarda en `users/{uid}/agentSecrets/{provider}`. La UI solo muestra
los últimos 4 chars (`***ab12`).

### Citation graph

```text
GET    /api/documents/:id/citations
POST   /api/documents/:id/citations           # upsert citation
DELETE /api/documents/:id/citations/:cid
POST   /api/admin/citations/backfill          # admin / cron diario 04:00 UTC
```

Tools del agente: `query_citation_graph`, `find_related_via_graph`,
`expand_context`.

### Custom claims Firebase

`syncWorkspaceClaims` se cablea en las mutaciones de members
(create/update/remove). Mantiene `customClaims.workspaces` en sincronía
para que las reglas Firestore restrinjan acceso por workspace sin un
roundtrip al backend.

Existe un Cloud Function trigger creado pero **no deployado** (defense
in depth) — el cableado backend ya cubre.

### Upload multipart >50MB

```text
POST /api/upload/multipart/initiate           # → { uploadId, key }
POST /api/upload/multipart/sign-part          # → URL firmada para PUT por chunk
POST /api/upload/multipart/complete           # ensambla partes
POST /api/upload/multipart/abort
```

### Git providers externos

Vault AES-256-GCM (mismo esquema que API keys) +
`isomorphic-git`. Permite vincular workspaces a repos GitHub/GitLab/SSH
externos.

### Search

`/api/search` consulta `searchableContent` (full-text) en lugar de
solo metadata.

## Seguridad

- HSTS via `helmet` (max-age 63072000 includeSubDomains preload).
- Service Account Firebase rotada (Secret Manager v3 enabled, v1/v2 disabled).
- Backfill custom claims ejecutado para todos los users existentes.
