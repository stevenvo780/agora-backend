/**
 * Helpers para sembrar archivos de configuración por defecto en un workspace
 * recién creado o recién provisionado con Git.
 *
 *   `.syncignore` — siempre presente (al crear workspace). Define qué archivos
 *                   ignora el sync NAS↔worker. Defaults razonables que evitan
 *                   conflictos típicos (vim swap files, .DS_Store, etc.).
 *
 *   `.gitignore`  — sólo cuando se provisiona el repo Git. Plantilla VACÍA
 *                   (sólo encabezado). El user decide qué excluir del commit
 *                   git, sin imponer defaults — el sync al NAS ya filtra lo
 *                   problemático para sync, y para git el coste es del user.
 */
import { adminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { putObject, isNasConfigured } from '@/lib/nas-storage';
import { buildStoragePath } from '@/lib/storage-path';
import { emitPing } from '@/lib/nas-events';

export const SYNCIGNORE_DEFAULT = `# .syncignore — reglas de sincronización NAS ↔ workers.
# Formato gitignore. Una regla por línea.
# Estos archivos NO se replican entre el NAS y el worker (en ninguna dirección).
# Editable: cambia este archivo desde la web y los workers se actualizan en segundos.

# Archivos temporales de editores
*.swp
*.swo
*.swn
*~
.~lock.*
.#*

# OS y caches
.DS_Store
Thumbs.db
desktop.ini
*.tmp
*.cache
.cache/
`;

export const GITIGNORE_DEFAULT = `# .gitignore — reglas de exclusión para los commits a Git.
# Formato gitignore estándar. Una regla por línea.
# Edita este archivo para indicar qué NO incluir en commits.
# Ejemplos comunes (descoméntalos si aplican):

# node_modules/
# .next/
# dist/
# build/
# *.log
# .env
# .env.local
`;

interface SeedDefaultDocOptions {
  workspaceId: string;
  ownerId: string;
  name: string;
  content: string;
  mimeType: string;
}

const seedDoc = async (opts: SeedDefaultDocOptions): Promise<string | null> => {
  if (!isNasConfigured()) return null;

  // Idempotente: si ya existe, no hacer nada.
  const existing = await adminDb.collection('documents')
    .where('workspaceId', '==', opts.workspaceId)
    .where('name', '==', opts.name)
    .limit(1)
    .get();
  if (!existing.empty) return existing.docs[0]?.id ?? null;

  const folder = '';
  const storagePath = buildStoragePath({
    workspaceId: opts.workspaceId,
    ownerId: opts.ownerId,
    folder,
    fileName: opts.name
  });
  const out = await putObject(storagePath, opts.content, {
    contentType: opts.mimeType,
    metadata: { 'agora-source': 'workspace-default', 'agora-owner': opts.ownerId }
  });

  const ref = await adminDb.collection('documents').add({
    name: opts.name,
    type: 'text',
    mimeType: opts.mimeType,
    workspaceId: opts.workspaceId,
    ownerId: opts.ownerId,
    folder,
    storagePath,
    storageBackend: 'minio',
    contentHash: out.contentHash,
    size: out.size,
    version: 1,
    baseVersion: 0,
    syncState: 'synced',
    lastWriter: opts.ownerId,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  });

  await emitPing({
    scope: 'document',
    op: 'created',
    workspaceId: opts.workspaceId,
    userId: opts.ownerId,
    docId: ref.id,
    path: storagePath,
    folder,
    contentHash: out.contentHash,
    sender: 'workspace-defaults'
  }).catch(() => undefined);

  return ref.id;
};

export const seedSyncignore = (workspaceId: string, ownerId: string) =>
  seedDoc({ workspaceId, ownerId, name: '.syncignore', content: SYNCIGNORE_DEFAULT, mimeType: 'text/plain' });

export const seedGitignore = (workspaceId: string, ownerId: string) =>
  seedDoc({ workspaceId, ownerId, name: '.gitignore', content: GITIGNORE_DEFAULT, mimeType: 'text/plain' });
