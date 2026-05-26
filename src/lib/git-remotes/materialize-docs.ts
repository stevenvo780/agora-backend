/**
 * Materializa los archivos de un repo clonado (tmp dir) como DOCUMENTOS del
 * workspace: blob en MinIO + doc en Firestore `documents`, usando el mismo
 * path canónico que la creación normal (`createDocumentBlob` / `putObject`).
 *
 * Esto es lo que hace que un `import` de repo externo APAREZCA en el workspace:
 * el push a Forgejo provee la capa git, pero el user ve los archivos porque
 * acá quedan como docs (con `searchableContent`, ping RTDB, etc.).
 *
 * Idempotente: si ya existe un doc con el mismo `storagePath` se actualiza su
 * blob+metadata (no se duplica). Acota por nº de archivos y bytes totales para
 * no reventar memoria/cuota con un repo gigante; reporta si truncó.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '@/lib/firebase-admin';
import { DocumentType } from '@/types/documents';
import { buildStoragePath, ensureTextFileName, sanitizeFileName } from '@/lib/storage-path';
import { createDocumentBlob, writeDocumentBlob } from '@/lib/documents/writeDocumentBlob';
import { putObject, presignGet } from '@/lib/nas-storage';
import { emitPing } from '@/lib/nas-events';
import { getErrorMessage } from '@/lib/error-utils';

export interface MaterializeOptions {
  workspaceId: string;
  ownerUid: string;
  /** Límite de archivos a materializar como docs. */
  maxFiles?: number;
  /** Límite de bytes totales a materializar. */
  maxTotalBytes?: number;
  /** Tamaño máximo por archivo individual. */
  maxFileBytes?: number;
}

export interface MaterializeResult {
  /** Docs creados o actualizados con éxito. */
  created: number;
  /** Archivos saltados (binarios enormes, dirs ignoradas, errores puntuales). */
  skipped: number;
  /** true si se alcanzó algún cap (faltaron archivos por materializar). */
  truncated: boolean;
  /** Bytes totales materializados. */
  bytes: number;
}

const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024; // 64 MiB total
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB por archivo

// Directorios que nunca tienen sentido como docs del workspace.
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  '.cache',
  '.turbo',
  '__pycache__',
  '.venv',
  'venv'
]);

// Extensiones que tratamos como texto (doc tipo `text`, con searchableContent).
// El resto se sube como blob (doc tipo `file`).
const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.mdx', '.txt', '.text', '.rst',
  '.st', '.stnb',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.swift', '.scala',
  '.sh', '.bash', '.zsh', '.fish', '.sql', '.html', '.htm', '.css', '.scss',
  '.sass', '.less', '.xml', '.svg', '.csv', '.tsv', '.tex', '.bib',
  '.gitignore', '.gitattributes', '.editorconfig', '.dockerignore', '.npmignore'
]);

const MIME_BY_EXT: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.mdx': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf'
};

const isTextFile = (relPath: string, sample: Buffer): boolean => {
  const ext = path.posix.extname(relPath).toLowerCase();
  const base = path.posix.basename(relPath);
  // Dotfiles conocidos sin extensión (`.gitignore`…) → texto.
  if (TEXT_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(base)) return true;
  // Heurística: si los primeros bytes no contienen NUL, lo tratamos como texto.
  const probe = sample.subarray(0, Math.min(sample.length, 8000));
  return !probe.includes(0);
};

const mimeFor = (relPath: string): string => {
  const ext = path.posix.extname(relPath).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
};

/**
 * Mapea `dir/sub/file.md` (relativo al root del repo) a `{ folder, name }` del
 * doc del workspace, sanitizando cada segmento como hace MinIO/forgejo-path.
 */
const splitRepoRelPath = (relPath: string): { folder: string; name: string } => {
  const posix = relPath.split(path.sep).join('/');
  const segments = posix.split('/').filter(Boolean);
  const name = segments.pop() ?? 'untitled';
  const folder = segments
    .map((s) => sanitizeFileName(s.trim()).replace(/^\.+$/, '_'))
    .filter(Boolean)
    .join('/');
  return { folder, name };
};

/** Lista recursiva de archivos del repo, saltando dirs ignoradas. */
const walkRepoFiles = async (rootDir: string): Promise<string[]> => {
  const out: string[] = [];
  const recurse = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await recurse(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        out.push(path.join(dir, entry.name));
      }
    }
  };
  await recurse(rootDir);
  // Orden estable (raíz primero, alfabético) para que el cap trunque de forma
  // determinista y los archivos "importantes" (README) tiendan a entrar.
  out.sort((a, b) => a.localeCompare(b));
  return out;
};

/** Un archivo seleccionado para materializar, con su mapping resuelto. */
export interface PlannedFile {
  absPath: string;
  relPath: string;
  folder: string;
  name: string;
  fileName: string;
  storagePath: string;
  isText: boolean;
  size: number;
  buf: Buffer;
}

export interface MaterializationPlan {
  files: PlannedFile[];
  skipped: number;
  truncated: boolean;
  bytes: number;
}

/**
 * Decide QUÉ archivos del repo se materializan y CÓMO se mapean (folder/name/
 * storagePath/text-vs-binary), aplicando los caps. No toca Firestore/MinIO:
 * es la lógica de borde pura y testeable. La materialización real la consume.
 */
export const planMaterialization = async (
  rootDir: string,
  opts: MaterializeOptions
): Promise<MaterializationPlan> => {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  const absFiles = await walkRepoFiles(rootDir);
  const plan: MaterializationPlan = { files: [], skipped: 0, truncated: false, bytes: 0 };

  for (const absPath of absFiles) {
    if (plan.files.length >= maxFiles) {
      plan.truncated = true;
      break;
    }
    const relPath = path.relative(rootDir, absPath);
    if (!relPath || relPath.startsWith('..')) {
      plan.skipped += 1;
      continue;
    }
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.stat(absPath);
    } catch {
      plan.skipped += 1;
      continue;
    }
    if (stat.size > maxFileBytes) {
      plan.skipped += 1;
      continue;
    }
    if (plan.bytes + stat.size > maxTotalBytes) {
      plan.truncated = true;
      break;
    }
    let buf: Buffer;
    try {
      buf = await fs.readFile(absPath);
    } catch {
      plan.skipped += 1;
      continue;
    }
    const { folder, name } = splitRepoRelPath(relPath);
    const isText = isTextFile(relPath, buf);
    const fileName = isText ? ensureTextFileName(name) : (sanitizeFileName(name) || 'untitled');
    const storagePath = buildStoragePath({
      workspaceId: opts.workspaceId,
      ownerId: opts.ownerUid,
      folder,
      fileName
    });
    plan.files.push({ absPath, relPath, folder, name, fileName, storagePath, isText, size: stat.size, buf });
    plan.bytes += stat.size;
  }

  return plan;
};

const findExistingDocId = async (workspaceId: string, storagePath: string): Promise<string | null> => {
  try {
    const snap = await adminDb.collection('documents')
      .where('workspaceId', '==', workspaceId)
      .where('storagePath', '==', storagePath)
      .limit(1)
      .get();
    return snap.empty ? null : (snap.docs[0]?.id ?? null);
  } catch {
    return null;
  }
};

/**
 * Recorre el repo clonado y crea/actualiza un documento por archivo.
 * `rootDir` es el workdir donde isomorphic-git clonó el remoto.
 */
export const materializeRepoAsDocuments = async (
  rootDir: string,
  opts: MaterializeOptions
): Promise<MaterializeResult> => {
  const plan = await planMaterialization(rootDir, opts);
  const result: MaterializeResult = {
    created: 0,
    skipped: plan.skipped,
    truncated: plan.truncated,
    bytes: 0
  };

  for (const file of plan.files) {
    const { relPath, folder, fileName, storagePath, isText, size, buf } = file;

    try {
      if (isText) {
        const ext = path.posix.extname(fileName).toLowerCase();
        const contentType = ext === '.md' || ext === '.markdown' || ext === '.mdx'
          ? 'text/markdown'
          : mimeFor(fileName) === 'application/octet-stream'
            ? 'text/plain'
            : mimeFor(fileName);
        const content = buf.toString('utf8');

        const existingId = await findExistingDocId(opts.workspaceId, storagePath);
        if (existingId) {
          const ref = adminDb.collection('documents').doc(existingId);
          const snap = await ref.get();
          const baseVersion = typeof snap.data()?.version === 'number' ? (snap.data()!.version as number) : 0;
          await writeDocumentBlob({
            docRef: ref,
            content,
            workspaceId: opts.workspaceId,
            ownerId: opts.ownerUid,
            storagePath,
            contentType,
            source: 'api-update',
            writerId: opts.ownerUid,
            baseVersion,
            emitPingPayload: { userId: opts.ownerUid, op: 'updated' }
          });
        } else {
          const docRef = adminDb.collection('documents').doc();
          await createDocumentBlob({
            docRef,
            content,
            workspaceId: opts.workspaceId,
            ownerId: opts.ownerUid,
            storagePath,
            contentType,
            source: 'api-create',
            writerId: opts.ownerUid,
            initialDocData: {
              name: fileName,
              type: DocumentType.Text,
              mimeType: contentType,
              ownerId: opts.ownerUid,
              workspaceId: opts.workspaceId,
              folder,
              createdAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp()
            },
            emitPingPayload: { userId: opts.ownerUid, op: 'created' }
          });
        }
      } else {
        const mimeType = mimeFor(fileName);
        const put = await putObject(storagePath, buf, {
          contentType: mimeType,
          metadata: { 'agora-source': 'api-create', 'agora-owner': opts.ownerUid }
        });
        const url = await presignGet(storagePath, 60 * 60).catch(() => undefined);

        const existingId = await findExistingDocId(opts.workspaceId, storagePath);
        const ref = existingId
          ? adminDb.collection('documents').doc(existingId)
          : adminDb.collection('documents').doc();
        const docData: Record<string, unknown> = {
          name: fileName,
          type: DocumentType.File,
          mimeType,
          storagePath,
          storageBackend: 'minio',
          contentHash: put.contentHash,
          size: put.size,
          version: 1,
          baseVersion: 0,
          syncState: 'synced',
          lastWriter: opts.ownerUid,
          ownerId: opts.ownerUid,
          workspaceId: opts.workspaceId,
          folder,
          updatedAt: FieldValue.serverTimestamp()
        };
        if (url) docData.url = url;
        if (existingId) {
          await ref.update(docData);
        } else {
          docData.createdAt = FieldValue.serverTimestamp();
          await ref.set(docData);
        }
        await emitPing({
          scope: 'document',
          workspaceId: opts.workspaceId,
          userId: opts.ownerUid,
          docId: ref.id,
          path: storagePath,
          version: 1,
          contentHash: put.contentHash,
          sender: opts.ownerUid,
          op: existingId ? 'updated' : 'created'
        }).catch(() => undefined);
      }

      result.created += 1;
      result.bytes += size;
    } catch (err) {
      console.warn('[materialize-docs] file skipped:', relPath, getErrorMessage(err));
      result.skipped += 1;
    }
  }

  return result;
};

/** Util de test/uso aislado: crea un tmp dir para materializar. */
export const mkMaterializeTmp = (): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), 'agora-materialize-'));
