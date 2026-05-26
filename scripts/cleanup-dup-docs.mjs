#!/usr/bin/env node
/**
 * Limpia docs basura del workspace personal del user.
 *
 * Detecta documentos cuyo nombre:
 *  - Contiene "__dup__" (ej: "Sin título__dup__abc123")
 *  - Coincide con /^Sin título(\d+|__dup__\w+)/
 *  - Es exactamente "Sin título" seguido de caracteres numéricos (ej: "Sin título1")
 *
 * Uso:
 *   FIREBASE_SERVICE_ACCOUNT='<json>' node scripts/cleanup-dup-docs.mjs [--delete]
 *
 * Por defecto corre en DRY-RUN (solo imprime). Pasar --delete para borrar de verdad.
 *
 * Variables opcionales:
 *   OWNER_UID=21VuZW4cdXd9jGKOgPa5YQegICw1  (default hardcoded)
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const DELETE = process.argv.includes('--delete');
const OWNER_UID = process.env.OWNER_UID ?? '21VuZW4cdXd9jGKOgPa5YQegICw1';
const PAGE = 200;

const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!sa) { console.error('FIREBASE_SERVICE_ACCOUNT requerido'); process.exit(1); }

let parsed;
try {
  parsed = JSON.parse(sa);
} catch {
  // Vercel escapa los saltos de línea como literales \n en la variable de entorno
  try {
    parsed = JSON.parse(sa.replace(/\\n/g, '\n'));
  } catch (e2) {
    console.error('No se pudo parsear FIREBASE_SERVICE_ACCOUNT:', e2.message);
    process.exit(1);
  }
}

initializeApp({ credential: cert(parsed), projectId: parsed.project_id ?? parsed.projectId });
const db = getFirestore();

/** Devuelve true si el nombre del doc es "basura" a eliminar */
function isJunk(name) {
  if (!name || typeof name !== 'string') return false;
  // Contiene __dup__ en cualquier posición
  if (name.includes('__dup__')) return true;
  // "Sin título" seguido de dígitos o variantes (Sin título1, Sin título 1)
  if (/^Sin título\s*\d+$/.test(name)) return true;
  // "Sin título" seguido de __dup__ u otros sufijos sin sentido
  if (/^Sin título__/.test(name)) return true;
  return false;
}

async function run() {
  console.log(`[cleanup-dup-docs] modo: ${DELETE ? 'ELIMINANDO (--delete pasado)' : 'DRY-RUN (solo lectura)'}`);
  console.log(`[cleanup-dup-docs] owner uid: ${OWNER_UID}`);
  console.log('');

  const junkDocs = [];
  let lastDoc = null;
  let scanned = 0;

  // Buscar en workspace personal ('personal') con ownerId del user
  while (true) {
    let q = db.collection('documents')
      .where('workspaceId', '==', 'personal')
      .where('ownerId', '==', OWNER_UID)
      .limit(PAGE);
    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      scanned++;
      const data = doc.data();
      const name = typeof data.name === 'string' ? data.name : '';
      if (isJunk(name)) {
        junkDocs.push({
          id: doc.id,
          name,
          storagePath: data.storagePath ?? null,
          size: data.size ?? 0,
          createdAt: data.createdAt?.toDate?.()?.toISOString() ?? 'unknown',
        });
      }
    }

    lastDoc = snap.docs[snap.docs.length - 1] ?? null;
    if (snap.size < PAGE) break;
  }

  console.log(`[cleanup-dup-docs] Escaneados: ${scanned} docs en workspace personal`);
  console.log(`[cleanup-dup-docs] Docs basura encontrados: ${junkDocs.length}`);
  console.log('');

  if (junkDocs.length === 0) {
    console.log('[cleanup-dup-docs] No hay nada que limpiar.');
    return;
  }

  console.log('--- Lista de docs a eliminar ---');
  for (const d of junkDocs) {
    console.log(`  ID: ${d.id}`);
    console.log(`    nombre: "${d.name}"`);
    console.log(`    storagePath: ${d.storagePath ?? '(sin storagePath)'}`);
    console.log(`    size: ${d.size} bytes`);
    console.log(`    createdAt: ${d.createdAt}`);
    console.log('');
  }

  console.log('--- Comandos MinIO para limpiar storage asociado ---');
  console.log('# Ejecutar en agora-storage VPS (si el doc tiene storagePath):');
  for (const d of junkDocs) {
    if (d.storagePath) {
      console.log(`ssh root@76.13.118.239 'docker compose -f /opt/agora-stack/docker-compose.yml exec -T agora-minio sh -c "mc alias set adm http://localhost:9000 agora-admin VzafdO1uPRF0ikP1PS4np6iHT1q5JtHX6aoCaHet >/dev/null && mc rm adm/agora-blobs/${d.storagePath}"'`);
    }
  }
  console.log('');

  console.log('--- Comando para eliminar de Firestore ---');
  console.log('# Re-ejecutar este script con --delete para borrar de Firestore:');
  console.log(`# FIREBASE_SERVICE_ACCOUNT='...' node scripts/cleanup-dup-docs.mjs --delete`);
  console.log('');

  if (DELETE) {
    console.log('[cleanup-dup-docs] Eliminando docs de Firestore...');
    const BATCH_SIZE = 20;
    let deleted = 0;
    for (let i = 0; i < junkDocs.length; i += BATCH_SIZE) {
      const batch = db.batch();
      const chunk = junkDocs.slice(i, i + BATCH_SIZE);
      for (const d of chunk) {
        batch.delete(db.collection('documents').doc(d.id));
      }
      await batch.commit();
      deleted += chunk.length;
      console.log(`[cleanup-dup-docs] Eliminados: ${deleted}/${junkDocs.length}`);
    }
    console.log('[cleanup-dup-docs] Listo. Firestore limpio.');
    console.log('[cleanup-dup-docs] RECUERDA: correr los comandos MinIO de arriba para limpiar el storage.');
  } else {
    console.log('[cleanup-dup-docs] DRY-RUN completado. Pasar --delete para eliminar.');
  }
}

run().catch((e) => {
  console.error('[cleanup-dup-docs] ERROR:', e);
  process.exit(1);
});
