import ignore, { type Ignore } from 'ignore';
import { adminDb } from '@/lib/firebase-admin';
import { getObjectBuffer, isNasConfigured } from '@/lib/nas-storage';

/**
 * Carga el `.gitignore` del workspace (si existe) y devuelve un matcher
 * `ignore` listo para filtrar `repoPath` antes de status/commit.
 *
 * Sin defaults: si el workspace no tiene `.gitignore`, no se ignora nada.
 * El usuario decide qué excluir subiendo el archivo a la raíz del workspace.
 */

interface DocLite {
  storagePath?: string;
  name?: string;
  folder?: string;
}

const findGitignoreDoc = async (workspaceQuery: FirebaseFirestore.Query): Promise<DocLite | null> => {
  const snap = await workspaceQuery.where('name', '==', '.gitignore').limit(5).get();
  if (snap.empty) return null;
  // Prefer el que esté en la raíz (folder = "No estructurado" / vacío).
  const docs = snap.docs.map(d => d.data() as DocLite);
  const root = docs.find(d => !d.folder || d.folder === 'No estructurado');
  return root ?? docs[0] ?? null;
};

/**
 * Construye el matcher para el workspace a partir del `.gitignore` que el
 * usuario haya subido. Si no hay `.gitignore`, el matcher no ignora nada.
 */
export const loadWorkspaceIgnore = async (workspaceQuery: FirebaseFirestore.Query): Promise<Ignore> => {
  const ig = ignore();
  const gi = await findGitignoreDoc(workspaceQuery);
  if (gi?.storagePath && isNasConfigured()) {
    try {
      const buf = await getObjectBuffer(gi.storagePath);
      if (buf) ig.add(buf.toString('utf8'));
    } catch (err) {
      console.warn('[forgejo-ignore] failed to load .gitignore:', (err as Error).message);
    }
  }
  return ig;
};

/** Decide si un `repoPath` debe ser excluido. El `.gitignore` mismo NO se ignora. */
export const isIgnoredPath = (ig: Ignore, repoPath: string): boolean => {
  if (!repoPath || repoPath === '.gitignore' || repoPath.endsWith('/.gitignore')) return false;
  return ig.ignores(repoPath);
};

// Export para tests / debug.
export { adminDb };
