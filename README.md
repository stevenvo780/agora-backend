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
FIREBASE_SERVICE_ACCOUNT=

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

WORKER_SYNC_SECRET=
WORKER_SECRET=
WORKER_SECRET_PREVIOUS=
CRON_SECRET=
BACKEND_INTERNAL_SECRET=
ENABLE_ADMIN_ENDPOINTS=false
APP_PASSWORD=

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
  --min-instances 1 \
  --max-instances 5 \
  --set-env-vars "ALLOWED_ORIGINS=https://agora.humanizar.cloud,FIREBASE_PROJECT_ID=udea-filosofia"
```

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
