/**
 * resolveDoc.ts — resolución permisiva de docId para el citation graph.
 *
 * Estrategia en orden de prioridad:
 *   1. docId exacto en Firestore (match directo al documento).
 *   2. Nombre exacto (case-insensitive) en el workspace.
 *   3. Slug-like: compara el input como slug kebab contra el nombre normalizado.
 *   4. Fuzzy: busca en `name` o `searchableContent` (substring, case-insensitive),
 *      ordenado por `updatedAt DESC`, toma el primero.
 *
 * Cuando se usa el path 2-4 el resultado incluye `resolvedFromAmbiguousInput: true`
 * y `actualDocId` para que el agente IA sepa que se resolvió desde input ambiguo.
 */

import { adminDb } from '@/lib/firebase-admin';
import { isPersonalWorkspaceId, PERSONAL_WORKSPACE_ID } from '@/types/workspace';

export interface ResolvedDocRef {
  actualDocId: string;
  resolvedFromAmbiguousInput: boolean;
  matchedBy: 'exact-id' | 'exact-name' | 'slug' | 'fuzzy-name' | 'fuzzy-content';
}

const toSlug = (s: string): string =>
  s.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

const looksLikeFirestoreId = (s: string): boolean =>
  /^[A-Za-z0-9]{20}$/.test(s);

/**
 * Intenta resolver un string (docId, nombre, slug, texto parcial) al ID
 * de Firestore del documento dentro del workspace del usuario.
 *
 * @returns `ResolvedDocRef` si se encontró, `null` si no hay match.
 */
export async function fuzzyResolveDocId(
  input: string,
  workspaceId: string,
  uid: string
): Promise<ResolvedDocRef | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // 1. Intento directo por docId (siempre, sea o no formato Firestore)
  const directSnap = await adminDb.collection('documents').doc(trimmed).get();
  if (directSnap.exists) {
    const data = directSnap.data() as Record<string, unknown>;
    const docWs = typeof data.workspaceId === 'string' ? data.workspaceId : PERSONAL_WORKSPACE_ID;
    const docOwner = typeof data.ownerId === 'string' ? data.ownerId : null;
    const belongsToWorkspace = isPersonalWorkspaceId(workspaceId)
      ? docOwner === uid
      : docWs === workspaceId;
    if (belongsToWorkspace) {
      return { actualDocId: trimmed, resolvedFromAmbiguousInput: false, matchedBy: 'exact-id' };
    }
  }

  // Para los pasos 2-4 cargamos los docs del workspace de una sola vez
  const docsRef = adminDb.collection('documents');
  const baseQuery = isPersonalWorkspaceId(workspaceId)
    ? docsRef.where('ownerId', '==', uid).where('workspaceId', '==', PERSONAL_WORKSPACE_ID)
    : docsRef.where('workspaceId', '==', workspaceId);

  // Ordenar por updatedAt DESC para que el fuzzy tome el más reciente
  let snap: FirebaseFirestore.QuerySnapshot;
  try {
    snap = await baseQuery.orderBy('updatedAt', 'desc').limit(2000).get();
  } catch {
    // Fallback si falta el índice compuesto
    snap = await baseQuery.limit(2000).get();
  }

  if (snap.empty) return null;

  const inputLower = trimmed.toLowerCase();
  const inputSlug = toSlug(trimmed);

  // 2. Nombre exacto (case-insensitive)
  for (const doc of snap.docs) {
    const name = typeof doc.data().name === 'string' ? (doc.data().name as string).trim().toLowerCase() : '';
    if (name === inputLower) {
      return { actualDocId: doc.id, resolvedFromAmbiguousInput: true, matchedBy: 'exact-name' };
    }
  }

  // 3. Slug: comparar slug del input contra slug del nombre del doc
  if (inputSlug.length >= 2) {
    for (const doc of snap.docs) {
      const name = typeof doc.data().name === 'string' ? (doc.data().name as string) : '';
      if (toSlug(name) === inputSlug) {
        return { actualDocId: doc.id, resolvedFromAmbiguousInput: true, matchedBy: 'slug' };
      }
    }
  }

  // 4a. Fuzzy por nombre (substring)
  for (const doc of snap.docs) {
    const name = typeof doc.data().name === 'string' ? (doc.data().name as string).toLowerCase() : '';
    if (name.includes(inputLower) || inputLower.includes(name)) {
      return { actualDocId: doc.id, resolvedFromAmbiguousInput: true, matchedBy: 'fuzzy-name' };
    }
  }

  // 4b. Fuzzy por searchableContent (substring, toma el más reciente por updatedAt)
  for (const doc of snap.docs) {
    const content = typeof doc.data().searchableContent === 'string'
      ? (doc.data().searchableContent as string).toLowerCase()
      : '';
    if (content.length > 0 && content.includes(inputLower)) {
      return { actualDocId: doc.id, resolvedFromAmbiguousInput: true, matchedBy: 'fuzzy-content' };
    }
  }

  return null;
}
