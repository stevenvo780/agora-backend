import admin from 'firebase-admin';

/**
 * Firebase Admin para el backend en Cloud Run.
 *
 * Estrategia de credenciales:
 * 1. Si corre en Cloud Run con la cuenta de servicio del proyecto Firebase,
 *    `applicationDefault()` resuelve sin variables.
 * 2. Si está fuera (dev local) acepta `FIREBASE_SERVICE_ACCOUNT` como JSON
 *    en una sola variable de entorno (mismo patrón que el hub Vercel).
 */

let initialized = false;

function ensureInitialized() {
  if (initialized) return;
  initialized = true;

  if (admin.apps.length > 0) return;

  const projectId = process.env.FIREBASE_PROJECT_ID || 'udea-filosofia';
  const databaseURL = process.env.FIREBASE_DATABASE_URL || `https://${projectId}-default-rtdb.firebaseio.com`;

  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (sa) {
    try {
      const parsed = JSON.parse(sa);
      admin.initializeApp({
        credential: admin.credential.cert(parsed),
        databaseURL
      });
      return;
    } catch (e) {
      console.error('[firebaseAdmin] FIREBASE_SERVICE_ACCOUNT inválido, usando applicationDefault()', e);
    }
  }

  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL,
    projectId
  });
}

export function firestore() {
  ensureInitialized();
  return admin.firestore();
}

export function auth() {
  ensureInitialized();
  return admin.auth();
}

export { admin };
