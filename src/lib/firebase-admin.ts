import { cert, getApps, initializeApp, App, getApp, type ServiceAccount } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

type FirebaseServiceAccount = {
  projectId?: string;
  clientEmail?: string;
  privateKey?: string;
  project_id?: string;
  client_email?: string;
  private_key?: string;
};

const serviceAccountStr = process.env.FIREBASE_SERVICE_ACCOUNT
  ? process.env.FIREBASE_SERVICE_ACCOUNT.trim()
  : undefined;

function normalizePrivateKeyMultilineJson(raw: string): string {
  return raw.replace(/"private_key"\s*:\s*"([\s\S]*?)"/m, (_match, privateKey) => {
    const normalizedPrivateKey = privateKey.replace(/\r\n/g, '\n').replace(/\n/g, '\\n');
    return `"private_key":"${normalizedPrivateKey}"`;
  });
}

function parseServiceAccount(raw?: string): ServiceAccount | undefined {
  if (!raw || raw === '{}' || !raw.includes('private_key')) return undefined;

  const candidates = [raw, normalizePrivateKeyMultilineJson(raw)];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as FirebaseServiceAccount;
      const projectId = parsed.projectId ?? parsed.project_id;
      const clientEmail = parsed.clientEmail ?? parsed.client_email;
      const privateKey = (parsed.privateKey ?? parsed.private_key)?.replace(/\\n/g, '\n');

      if (clientEmail && privateKey) {
        return {
          projectId,
          clientEmail,
          privateKey
        };
      }
    } catch {
      // probar siguiente variante sin ensuciar el build
    }
  }

  return undefined;
}

const serviceAccount = parseServiceAccount(serviceAccountStr);

const projectId = process.env.FIREBASE_PROJECT_ID ? process.env.FIREBASE_PROJECT_ID.trim() : undefined;
const configuredRtdbUrl = process.env.FIREBASE_DATABASE_URL ? process.env.FIREBASE_DATABASE_URL.trim() : undefined;
const fallbackRtdbUrl = projectId ? `https://${projectId}-default-rtdb.firebaseio.com` : undefined;
const databaseURL = configuredRtdbUrl || fallbackRtdbUrl;

// Firebase Storage NO se usa: los blobs viven en MinIO (NAS).
// Sólo cableamos credentials, projectId y RTDB.
let app: App;

if (!getApps().length) {
  if (serviceAccount) {
    app = initializeApp({
      credential: cert(serviceAccount),
      projectId,
      databaseURL
    });
  } else {
    app = initializeApp({ projectId, databaseURL });
  }
} else {
  app = getApp();
}

const adminAuth = getAuth(app);
const adminDb = getFirestore(app);

export { adminAuth, adminDb };
