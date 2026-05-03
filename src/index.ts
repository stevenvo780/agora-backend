import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { auditOnce } from '@/lib/env';
import { mountNextStyleApiRoutes } from './routes/nextApiRouter.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

const ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://agora.elenxos.com,https://agora.humanizar.cloud,http://localhost:3000')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`Origen no permitido: ${origin}`));
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
  ]
}));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'agora-backend', timestamp: new Date().toISOString() });
});

auditOnce();
await mountNextStyleApiRoutes(app);

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  console.log(`[agora-backend] Listening on ${PORT}`);
});
