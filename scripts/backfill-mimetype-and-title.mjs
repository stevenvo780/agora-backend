#!/usr/bin/env node
/**
 * Backfill BUG B1 + B4 (2026-05-28).
 *
 * B1: 1493 docs en Firestore tienen `mimeType: null` o `''`. El schema Zod
 *     del front (`resolvedDocumentMetaSchema.mimeType: z.string()`) rechaza
 *     ese payload con "Invalid input: expected string, received null" y los
 *     docs no abren en el editor (104 confirmados en workspace
 *     JhRFIASsH0dkmh7TkCiX). Setea mimeType inferido por type/extension.
 *
 * B4: docs creados por API con name="Sin titulo" pero content que arranca
 *     con `# Heading` muestran filename en search en vez del H1. Para esos,
 *     extrae el H1 como nuevo name.
 *
 * Uso:
 *   FIREBASE_SERVICE_ACCOUNT='<json>' node scripts/backfill-mimetype-and-title.mjs [--dry] [--no-title]
 *
 *   --dry      no escribe, solo cuenta.
 *   --no-title solo arregla mimeType, no toca name.
 *
 * Recomendado pausar agora-host-sync mientras corre, igual que otros
 * migration scripts del repo.
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const dry = process.argv.includes('--dry');
const skipTitle = process.argv.includes('--no-title');
const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!sa) {
  console.error('FIREBASE_SERVICE_ACCOUNT requerido (JSON inline o leído desde Secret Manager).');
  process.exit(1);
}

const credential = cert(JSON.parse(sa));
initializeApp({ credential });
const db = getFirestore();

// --- Inferencia mimeType (mismo mapping que src/lib/documents/metadata-defaults.ts).
const TEXT_EXT_TO_MIME = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'text/plain',
  '.ini': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.scss': 'text/css',
  '.sass': 'text/css',
  '.less': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.cjs': 'application/javascript',
  '.ts': 'application/typescript',
  '.tsx': 'application/typescript',
  '.jsx': 'application/javascript',
  '.py': 'text/x-python',
  '.rb': 'text/x-ruby',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.sh': 'application/x-sh',
  '.bash': 'application/x-sh',
  '.zsh': 'application/x-sh',
  '.fish': 'application/x-sh',
  '.env': 'text/plain',
  '.conf': 'text/plain',
  '.cfg': 'text/plain',
  '.diff': 'text/x-diff',
  '.patch': 'text/x-diff',
  '.st': 'text/plain',
  '.sql': 'application/sql'
};

const BINARY_EXT_TO_MIME = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.zip': 'application/zip'
};

function extOf(name) {
  if (typeof name !== 'string') return '';
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) return '';
  return lower.slice(dot);
}

function resolveMime(type, name, storagePath) {
  const ext = extOf(name) || extOf(storagePath);
  if (type === 'folder') return 'inode/directory';
  if (type === 'text') return TEXT_EXT_TO_MIME[ext] ?? 'text/markdown';
  if (type === 'file') return BINARY_EXT_TO_MIME[ext] ?? TEXT_EXT_TO_MIME[ext] ?? 'application/octet-stream';
  return TEXT_EXT_TO_MIME[ext] ?? 'application/json';
}

function deriveName(rawName, content) {
  const trimmed = typeof rawName === 'string' ? rawName.trim() : '';
  const placeholder = trimmed.length === 0 || trimmed.toLowerCase() === 'sin titulo';
  if (!placeholder) return null;
  if (typeof content !== 'string' || content.length === 0) return null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const m = /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) return null;
    const heading = m[1]?.trim();
    if (!heading) return null;
    return heading.slice(0, 200);
  }
  return null;
}

async function fetchContentForTitle(storagePath) {
  if (!skipTitle && typeof storagePath === 'string' && storagePath.length > 0) {
    // El backfill de title requiere leer MinIO. Lo intentamos vía endpoint
    // interno si NEXUS_URL está disponible; si no, omitimos title backfill.
    return null;
  }
  return null;
}

async function run() {
  console.log(`[backfill] modo: ${dry ? 'DRY (no escribe)' : 'APLICANDO'} | title backfill: ${skipTitle ? 'OFF' : 'ON (best-effort)'}`);

  let scanned = 0;
  let mimeFixed = 0;
  let nameFixed = 0;
  let pageNum = 0;
  const PAGE = 300;

  // Iteramos sobre TODOS los docs (no se puede `where('mimeType', '==', null)`
  // de forma reliable en Firestore — falta de índice en docs viejos donde
  // el campo nunca fue creado). Filtramos en cliente.
  let lastDoc = null;
  while (true) {
    pageNum++;
    let q = db.collection('documents').orderBy('__name__').limit(PAGE);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;

    const batch = db.batch();
    let batchOps = 0;
    for (const docSnap of snap.docs) {
      scanned++;
      const data = docSnap.data();
      const mt = data.mimeType;
      const mtIsBad = mt === null || mt === undefined || (typeof mt === 'string' && mt.trim().length === 0);
      const type = typeof data.type === 'string' ? data.type : 'text';
      const name = typeof data.name === 'string' ? data.name : '';
      const storagePath = typeof data.storagePath === 'string' ? data.storagePath : '';

      const update = {};
      if (mtIsBad) {
        update.mimeType = resolveMime(type, name, storagePath);
        mimeFixed++;
      }

      // Backfill de title: si name es "Sin titulo"/vacío y hay content
      // legible, intentamos extraer el H1. Como no leemos MinIO desde aquí
      // (requeriría auth + S3 creds), si Firestore tiene `content` legacy
      // lo usamos; si no, skip — el fix solo aplica a docs nuevos.
      if (!skipTitle) {
        const placeholder = name.trim().length === 0 || name.trim().toLowerCase() === 'sin titulo';
        if (placeholder) {
          const legacyContent = typeof data.content === 'string' ? data.content : '';
          const derived = deriveName(name, legacyContent);
          if (derived && derived !== name) {
            update.name = derived;
            nameFixed++;
          }
        }
      }

      if (Object.keys(update).length > 0) {
        if (!dry) batch.update(docSnap.ref, update);
        batchOps++;
      }
    }
    if (!dry && batchOps > 0) await batch.commit();
    lastDoc = snap.docs[snap.docs.length - 1];
    console.log(`[backfill] página ${pageNum}: ${snap.size} docs (scanned acum: ${scanned}, mime fixes: ${mimeFixed}, name fixes: ${nameFixed})`);
    if (snap.size < PAGE) break;
  }

  console.log('');
  console.log('[backfill] DONE');
  console.log(`  scanned       : ${scanned}`);
  console.log(`  mimeType fixed: ${mimeFixed} ${dry ? '(dry, no se escribió)' : ''}`);
  console.log(`  name    fixed: ${nameFixed} ${dry ? '(dry, no se escribió)' : ''}`);
}

run().catch((e) => {
  console.error('[backfill] FAIL:', e);
  process.exit(1);
});
