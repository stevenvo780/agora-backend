import express from 'express';
import cors from 'cors';
import { chatStreamHandler } from './routes/chatStream.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

const ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://agora.elenxos.com,http://localhost:3000')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`Origen no permitido: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '4mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'agora-backend', timestamp: new Date().toISOString() });
});

app.post('/agora-ai/stream', chatStreamHandler);

// Compatibilidad con el path Vercel actual (rewrite simple).
app.post('/api/agora-ai/stream', chatStreamHandler);

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  console.log(`[agora-backend] Listening on ${PORT}`);
});
