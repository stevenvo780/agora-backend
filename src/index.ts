import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { auditOnce, auditProductionEnv } from '@/lib/env';
import { createRateLimitMiddleware } from '@/lib/rate-limit';
import { mountNextStyleApiRoutes } from './routes/nextApiRouter.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(helmet({
  contentSecurityPolicy: false,
  hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

const ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://agora.elenxos.com,https://agora.humanizar.cloud,http://localhost:3000')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ORIGINS.includes(origin)) return cb(null, true);
    // origin === 'null' viene de iframes sandboxed o requests programáticos
    // legítimos: rechazo silencioso para no contaminar Cloud Run errors.
    if (origin === 'null') return cb(null, false);
    console.debug(`[cors] origen no permitido: ${origin}`);
    cb(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Worker-Token',
    'X-Worker-Ts',
    'X-Worker-Sig',
    'X-Worker-Uid',
    'X-Worker-Signature',
    'X-Worker-Timestamp',
    'X-Backend-Internal-Secret',
    'X-Hub-Internal-Secret',
    'X-Cron-Secret',
    'X-Signature',
    'X-Request-Id'
  ],
  // Sin esto el browser bloqueaba el header X-Next-Cursor → cliente no
  // podía paginar y los archivos pasados los primeros 1000 quedaban
  // invisibles. Bug raíz "no aparece en jerarquía" 2026-05-06.
  exposedHeaders: [
    'X-Next-Cursor',
    'X-Request-Id'
  ]
}));

app.use((req, res, next) => {
  const incoming = req.get('x-request-id')?.trim();
  const requestId = incoming && incoming.length <= 128 ? incoming : randomUUID();
  req.headers['x-request-id'] = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'agora-backend', timestamp: new Date().toISOString() });
});

app.get('/health/deep', (req, res) => {
  const envAudit = auditProductionEnv();
  const envOk = envAudit.missing.length === 0;
  res.status(envOk ? 200 : 503).json({
    status: envOk ? 'ok' : 'degraded',
    service: 'agora-backend',
    requestId: req.get('x-request-id'),
    timestamp: new Date().toISOString(),
    checks: {
      env: {
        status: envOk ? 'ok' : 'degraded',
        missingCriticalCount: envAudit.missing.length,
        warningCount: envAudit.warnings.length
      }
    }
  });
});

const publicApiRateLimit = createRateLimitMiddleware({
  windowMs: Number(process.env.PUBLIC_API_RATE_LIMIT_WINDOW_MS || 60_000),
  maxPerWindow: Number(process.env.PUBLIC_API_RATE_LIMIT_MAX || 120),
  keyPrefix: 'public-api:'
});

app.use(['/api/auth', '/api/payments', '/api/agora-ai'], publicApiRateLimit);

auditOnce();
await mountNextStyleApiRoutes(app);

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  console.log(`[agora-backend] Listening on ${PORT}`);
});
