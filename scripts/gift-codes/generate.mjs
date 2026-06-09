/**
 * Generador de códigos de regalo para Agora.
 *
 * Formato de código: AGORA-XXXXX-XXXXX
 * Alfabeto: A-Z + 2-9 (excluye 0, O, 1, I, L para evitar ambigüedad visual)
 *
 * Uso:
 *   node scripts/gift-codes/generate.mjs                 # dry-run: solo escribe archivos
 *   node scripts/gift-codes/generate.mjs --write-firestore  # escribe en Firestore además
 *
 * Lotes que genera:
 *   Por duración (plan basic):
 *     basico-1mes.md   / basico-1mes.csv
 *     basico-3meses.md / basico-3meses.csv
 *     basico-6meses.md / basico-6meses.csv
 *   Por plan (1 mes):
 *     student-1mes.md  / student-1mes.csv
 *     basic-1mes.md    / basic-1mes.csv
 *     pro-1mes.md      / pro-1mes.csv
 *     enterprise-1mes.md / enterprise-1mes.csv
 *
 * Salida: carpeta gift-codes/ en la raíz del workspace (un nivel arriba de AgoraBack/).
 */

import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..', '..');
const OUTPUT_DIR = path.join(WORKSPACE_ROOT, 'gift-codes');

const WRITE_FIRESTORE = process.argv.includes('--write-firestore');

// Alfabeto sin caracteres ambiguos: 0/O/1/I/L
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const SEGMENT_LEN = 5;

/** Genera un segmento de N caracteres del alfabeto sin ambiguos */
function randomSegment(len) {
  const bytes = randomBytes(len * 2);
  let result = '';
  let i = 0;
  while (result.length < len) {
    const byte = bytes[i % bytes.length];
    i++;
    const idx = byte % ALPHABET.length;
    result += ALPHABET[idx];
  }
  return result;
}

/** Genera un código con formato AGORA-XXXXX-XXXXX */
function generateCode() {
  return `AGORA-${randomSegment(SEGMENT_LEN)}-${randomSegment(SEGMENT_LEN)}`;
}

/** Genera N códigos únicos */
function generateCodes(n) {
  const set = new Set();
  while (set.size < n) {
    set.add(generateCode());
  }
  return Array.from(set);
}

const CODES_PER_BATCH = 100;

const BATCHES = [
  { batch: 'basico-1mes',    planId: 'basic',      durationMonths: 1 },
  { batch: 'basico-3meses',  planId: 'basic',      durationMonths: 3 },
  { batch: 'basico-6meses',  planId: 'basic',      durationMonths: 6 },
  { batch: 'student-1mes',   planId: 'student',    durationMonths: 1 },
  { batch: 'basic-1mes',     planId: 'basic',      durationMonths: 1 },
  { batch: 'pro-1mes',       planId: 'pro',        durationMonths: 1 },
  { batch: 'enterprise-1mes',planId: 'enterprise', durationMonths: 1 }
];

const PLAN_NAMES = {
  free:       'Gratuito',
  student:    'Estudiante',
  basic:      'Básico',
  pro:        'Pro',
  enterprise: 'Enterprise'
};

/** Formatea una lista de codes en markdown legible */
function buildMarkdown(batch, planId, durationMonths, codes) {
  const planName = PLAN_NAMES[planId] ?? planId;
  const durStr = durationMonths === 1 ? '1 mes' : `${durationMonths} meses`;
  const createdAt = new Date().toISOString();
  const lines = [
    `# Códigos de regalo — ${planName} (${durStr})`,
    '',
    `- **Plan:** ${planName} (\`${planId}\`)`,
    `- **Duración:** ${durStr}`,
    `- **Lote:** \`${batch}\``,
    `- **Generados:** ${createdAt}`,
    `- **Total:** ${codes.length} códigos`,
    '',
    '> Guardar en lugar seguro. Cada código es de un solo uso.',
    '',
    '| # | Código |',
    '|---|--------|',
    ...codes.map((code, i) => `| ${String(i + 1).padStart(3, ' ')} | \`${code}\` |`)
  ];
  return lines.join('\n') + '\n';
}

/** Formatea una lista de codes en CSV */
function buildCsv(codes, planId, durationMonths, batch) {
  const rows = [
    'code,plan,durationMonths,batch',
    ...codes.map(code => `${code},${planId},${durationMonths},${batch}`)
  ];
  return rows.join('\n') + '\n';
}

/** Carga firebase-admin dinámicamente (solo si --write-firestore) */
async function loadFirebaseAdmin() {
  try {
    const { initializeApp, getApps, getApp, cert } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');

    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const serviceAccountStr = process.env.FIREBASE_SERVICE_ACCOUNT;

    let app;
    if (getApps().length > 0) {
      app = getApp();
    } else if (serviceAccountStr) {
      const sa = JSON.parse(serviceAccountStr);
      app = initializeApp({ credential: cert(sa) });
    } else if (credPath) {
      const { default: fs } = await import('node:fs');
      const sa = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      app = initializeApp({ credential: cert(sa) });
    } else {
      throw new Error(
        'Para --write-firestore necesitás GOOGLE_APPLICATION_CREDENTIALS o FIREBASE_SERVICE_ACCOUNT en el entorno.'
      );
    }

    return getFirestore(app);
  } catch (err) {
    console.error('[gift-codes] Error cargando firebase-admin:', err.message);
    throw err;
  }
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const createdAt = new Date().toISOString();

  // CSV consolidado por plan (todos los lotes)
  const consolidatedRows = ['code,plan,durationMonths,batch'];

  let db = null;
  if (WRITE_FIRESTORE) {
    console.log('[gift-codes] Modo --write-firestore: inicializando firebase-admin...');
    db = await loadFirebaseAdmin();
  } else {
    console.log('[gift-codes] Modo dry-run: solo se escriben archivos (usá --write-firestore para insertar en Firestore).');
  }

  for (const { batch, planId, durationMonths } of BATCHES) {
    const codes = generateCodes(CODES_PER_BATCH);

    // Markdown individual por lote
    const mdPath = path.join(OUTPUT_DIR, `${batch}.md`);
    await writeFile(mdPath, buildMarkdown(batch, planId, durationMonths, codes), 'utf8');
    console.log(`[gift-codes] Escribí ${mdPath} (${codes.length} códigos)`);

    // CSV individual por lote
    const csvPath = path.join(OUTPUT_DIR, `${batch}.csv`);
    await writeFile(csvPath, buildCsv(codes, planId, durationMonths, batch), 'utf8');
    console.log(`[gift-codes] Escribí ${csvPath}`);

    // Acumular en consolidado
    for (const code of codes) {
      consolidatedRows.push(`${code},${planId},${durationMonths},${batch}`);
    }

    if (db) {
      console.log(`[gift-codes] Insertando ${codes.length} docs en Firestore giftCodes (lote ${batch})...`);
      const CHUNK = 400;
      for (let i = 0; i < codes.length; i += CHUNK) {
        const chunk = codes.slice(i, i + CHUNK);
        const batchWrite = db.batch();
        for (const code of chunk) {
          const ref = db.collection('giftCodes').doc(code);
          batchWrite.set(ref, {
            code,
            planId,
            durationMonths,
            status: 'active',
            redeemedBy: null,
            redeemedAt: null,
            createdAt,
            batch
          });
        }
        await batchWrite.commit();
        console.log(`[gift-codes]   chunk ${i}-${i + chunk.length} escrito`);
      }
      console.log(`[gift-codes] Lote ${batch} insertado en Firestore.`);
    }
  }

  // CSV consolidado
  const consolidatedPath = path.join(OUTPUT_DIR, 'all-codes.csv');
  await writeFile(consolidatedPath, consolidatedRows.join('\n') + '\n', 'utf8');
  console.log(`[gift-codes] Escribí ${consolidatedPath} (consolidado: ${consolidatedRows.length - 1} códigos)`);

  console.log('\n[gift-codes] Listo.');
  if (!WRITE_FIRESTORE) {
    console.log('[gift-codes] Para insertar en Firestore: node scripts/gift-codes/generate.mjs --write-firestore');
  }
}

main().catch((err) => {
  console.error('[gift-codes] Error fatal:', err);
  process.exit(1);
});
