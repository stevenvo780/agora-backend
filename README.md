# AgoraBackend — Servicio de IA agéntico (Cloud Run)

Backend dedicado al streaming del agente IA (OpenAI / Anthropic / Gemini /
DeepSeek). Vive separado del hub Next.js para evitar el cap de duración de
Vercel (15 min) y el costo por GB-segundo en conversaciones largas.

## Arquitectura

```
Browser → agora.elenxos.com (Vercel UI/auth/Firestore/MinIO)
           │
           │ POST /api/agora-ai/stream  (rewrite → Cloud Run)
           ▼
        Cloud Run: agora-backend
           │  conversa con el provider (sin cap de minutos)
           │  cuando el LLM pide tools:
           ▼
        POST /api/agora-ai/internal/execute-tool en Vercel
           │  ejecuta tool con Firestore / MinIO / Forgejo / worker
           ▼
        regresa resultado al backend
           ▼
        backend continúa el stream
```

- El **streaming SSE** (lo costoso en tiempo) corre en Cloud Run con
  timeout de hasta 60 min y free tier abundante.
- Las **tools** siguen viviendo en Vercel donde están sus dependencias
  (Firestore admin, MinIO, Forgejo, socket.io a workers).
- Auth se hace con el mismo JWT de Firebase que ya usa el hub.

## Estructura

```
AgoraBackend/
├── Dockerfile             multi-stage build node:22-alpine
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts           Express bootstrap + CORS
    ├── routes/
    │   └── chatStream.ts  POST /agora-ai/stream (SSE)
    ├── lib/
    │   ├── firebaseAdmin.ts
    │   ├── auth.ts        verifyIdToken + isWorkspaceMember
    │   └── toolProxy.ts   delega tools al hub Vercel
    ├── agora-ai/          (copia de src/lib/agora-ai del hub)
    │   ├── types.ts
    │   ├── systemPrompt.ts
    │   ├── toolDefinitions.ts
    │   ├── accessPolicy.ts
    │   ├── rateLimit.ts
    │   └── providerAdapters.ts   (executor de tools INYECTADO)
    └── types/
        └── documents.ts
```

## Despliegue inicial a Cloud Run

Asume proyecto GCP `udea-filosofia` ya existe con billing habilitado.

```bash
# 1. Login y selección de proyecto
gcloud auth login
gcloud config set project udea-filosofia

# 2. Habilitar APIs requeridas (one-shot)
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  containerregistry.googleapis.com

# 3. Generar un secreto interno compartido entre el backend y el hub
HUB_INTERNAL_SECRET=$(openssl rand -hex 32)
echo "Guarda este valor — lo agregaremos también a Vercel:"
echo "$HUB_INTERNAL_SECRET"

# 4. Deploy (desde AgoraBackend/)
cd AgoraBackend
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
  --set-env-vars "FIREBASE_PROJECT_ID=udea-filosofia,HUB_INTERNAL_URL=https://agora.elenxos.com,ALLOWED_ORIGINS=https://agora.elenxos.com" \
  --set-secrets "HUB_INTERNAL_SECRET=hub-internal-secret:latest"

# 5. Crear el secret en Secret Manager (primera vez):
echo -n "$HUB_INTERNAL_SECRET" | gcloud secrets create hub-internal-secret \
  --data-file=- --replication-policy=automatic

# 6. Conceder a la cuenta de servicio del Cloud Run acceso al secret y a Firestore
PROJECT_NUMBER=$(gcloud projects describe udea-filosofia --format="value(projectNumber)")
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud secrets add-iam-policy-binding hub-internal-secret \
  --member="serviceAccount:${SA}" --role="roles/secretmanager.secretAccessor"

gcloud projects add-iam-policy-binding udea-filosofia \
  --member="serviceAccount:${SA}" --role="roles/datastore.user"

gcloud projects add-iam-policy-binding udea-filosofia \
  --member="serviceAccount:${SA}" --role="roles/firebase.sdkAdminServiceAgent"

# 7. Obtener la URL del servicio
SERVICE_URL=$(gcloud run services describe agora-backend --region us-central1 --format='value(status.url)')
echo "AgoraBackend URL: $SERVICE_URL"
```

## Configurar el hub Next.js (Vercel)

```bash
# Mismo secret que en el paso 3:
printf '%s' "$HUB_INTERNAL_SECRET" | vercel env add HUB_INTERNAL_SECRET production

# Si quieres redirigir el stream al backend en Cloud Run, añade en
# vercel.json (root del repo):
{
  "rewrites": [
    {
      "source": "/api/agora-ai/stream",
      "destination": "https://agora-backend-xxxxx-uc.a.run.app/agora-ai/stream"
    }
  ]
}

vercel --prod --yes
```

A partir de aquí, las requests del browser a `/api/agora-ai/stream` se sirven
desde Cloud Run sin cap de tiempo. El endpoint `/api/agora-ai/internal/execute-tool`
se queda en Vercel y solo lo llama AgoraBackend con el secret.

## Updates posteriores

```bash
cd AgoraBackend
gcloud run deploy agora-backend --source . --region us-central1
```

Cloud Run hace blue/green automático: el deploy nuevo recibe tráfico cuando
pasa health check; el viejo se descarta.

## Verificación end-to-end

```bash
# Health (sin auth)
curl https://agora-backend-xxxxx-uc.a.run.app/health

# Smoke test del stream (necesita un JWT real de Firebase)
TOKEN="<id-token-firebase>"
curl -N -X POST https://agora-backend-xxxxx-uc.a.run.app/agora-ai/stream \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "ping"}],
    "provider": "deepseek",
    "apiKey": "sk-...",
    "mode": "chat"
  }'
```

Esperás eventos `data: {...}` con `type: connected/status/step/complete`.

## Costo esperado en free tier

- 2M requests/mes gratis (cada conversación = 1 request).
- 360 000 GB-s/mes gratis con 1 GiB de memoria.
- Una conversación de 5 minutos consume ~5 × 60 = 300 segundos × 1 GB = 300 GB-s.
- Cabe holgadamente para hasta ~1 000 conversaciones largas/mes.
- Por encima del free tier: ~$0.000024/GB-s + $0.40/M requests.

## Desarrollo local

```bash
cd AgoraBackend
npm install
# Para auth local, copia el JSON de la service account de Firebase:
export FIREBASE_SERVICE_ACCOUNT="$(cat ./udea-filosofia-firebase-adminsdk.json)"
export HUB_INTERNAL_URL="http://localhost:3000"  # tu Next.js dev
export HUB_INTERNAL_SECRET="dev-secret"
export ALLOWED_ORIGINS="http://localhost:3000"
npm run dev
```
