/**
 * Calcula el uso total de almacenamiento de un usuario.
 * Fuente de la verdad: campo `size` en Firestore (poblado al hacer commit en MinIO).
 * Esto evita 1 round-trip por archivo a MinIO/HEAD y aprovecha que ya guardamos el size.
 *
 * Cache 10 min en memoria.
 */
import { adminDb } from '@/lib/firebase-admin';

const _usageCache = new Map<string, { bytes: number; ts: number }>();
const USAGE_CACHE_TTL_MS = 10 * 60 * 1000;

export const calculateOwnedStorageUsageBytes = async (uid: string): Promise<number> => {
  const cached = _usageCache.get(uid);
  if (cached && Date.now() - cached.ts < USAGE_CACHE_TTL_MS) return cached.bytes;

  const snapshot = await adminDb
    .collection('documents')
    .where('ownerId', '==', uid)
    .select('size')
    .get();

  let totalBytes = 0;
  for (const doc of snapshot.docs) {
    const size = (doc.data() as { size?: unknown }).size;
    if (typeof size === 'number' && size > 0) totalBytes += size;
  }

  _usageCache.set(uid, { bytes: totalBytes, ts: Date.now() });
  return totalBytes;
};

export const invalidateStorageUsageCache = (uid: string) => {
  _usageCache.delete(uid);
};
