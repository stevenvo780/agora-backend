#!/usr/bin/env node
/**
 * Migra docs Firestore con `folder = 'No estructurado'` → `folder = ''`.
 *
 * Uso:
 *   FIREBASE_SERVICE_ACCOUNT='<json>' node scripts/migrate-folder-default-to-empty.mjs [--dry]
 *
 * Recomendado pausar agora-host-sync mientras corre, para que un worker no
 * recree el string viejo durante la migración:
 *   ssh nas ssh stev-server 'systemctl stop agora-host-sync'
 *   # ... corre el script ...
 *   ssh nas ssh stev-server 'systemctl start agora-host-sync'
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const dry = process.argv.includes('--dry');
const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!sa) { console.error('FIREBASE_SERVICE_ACCOUNT requerido'); process.exit(1); }

const credential = cert(JSON.parse(sa));
initializeApp({ credential });
const db = getFirestore();

async function run() {
  console.log(`[migrate] modo: ${dry ? 'DRY (no escribe)' : 'APLICANDO cambios'}`);
  let scanned = 0, updated = 0;
  let lastDoc = null;
  const PAGE = 200;

  while (true) {
    let q = db.collection('documents').where('folder', '==', 'No estructurado').limit(PAGE);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;

    const batch = db.batch();
    for (const doc of snap.docs) {
      scanned++;
      if (!dry) batch.update(doc.ref, { folder: '' });
      updated++;
    }
    if (!dry) await batch.commit();
    lastDoc = snap.docs[snap.docs.length - 1];
    console.log(`[migrate] página: ${snap.size} docs (acumulado: ${scanned})`);
    if (snap.size < PAGE) break;
  }

  // También limpia entries de la subcolección de folders con path 'No estructurado'.
  // Esos son nodos virtuales pre-existentes que ya no se necesitan.
  let foldersDeleted = 0;
  const wsSnap = await db.collection('workspaces').get();
  for (const ws of wsSnap.docs) {
    const fSnap = await ws.ref.collection('folders').where('path', '==', 'No estructurado').get();
    for (const f of fSnap.docs) {
      foldersDeleted++;
      if (!dry) await f.ref.delete();
    }
  }

  console.log(`[migrate] OK — docs ${dry ? 'a actualizar' : 'actualizados'}: ${updated}; folder records ${dry ? 'a borrar' : 'borrados'}: ${foldersDeleted}`);
}

run().catch((e) => { console.error('[migrate] FAIL:', e); process.exit(1); });
