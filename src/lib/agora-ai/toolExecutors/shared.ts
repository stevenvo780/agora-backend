/**
 * Shared types, utilities and base functions used by all tool executor modules.
 * Extracted from toolExecutor.ts to enable domain-level splitting.
 */
import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '@/lib/firebase-admin';
import { putObject, deleteObject, getObjectBuffer } from '@/lib/nas-storage';
import { getErrorMessage } from '@/lib/error-utils';
import { normalizeFolderPath } from '@/lib/folder-utils';
import { buildStoragePath, ensureTextFileName } from '@/lib/storage-path';
import { isWorkspaceMember } from '@/lib/server-auth';
import { DocumentType } from '@/types/documents';
import { PERSONAL_WORKSPACE_ID, isPersonalWorkspaceId } from '@/types/workspace';
import { writeDocumentBlob } from '@/lib/documents/writeDocumentBlob';
import { invalidateAgoraWorkspaceContext } from '@/lib/agora-ai/context';
import {
  EMPTY_SEMANTIC_WORKSPACE_STATE,
  normalizeSemanticWorkspaceState,
  type SemanticWorkspaceState
} from '@/lib/semantic/workspace-state';
import type {
  AgentExecutionContext,
  AgentToolCall,
  AgentToolExecutionResult,
  AgentRollbackAction
} from '@/lib/agora-ai/types';
import {
  DEFAULT_DOC_LIMIT,
  MAX_DOC_SCAN,
  clamp,
  excerpt,
  sanitizeFirestoreValue,
  resolveSemanticDocId,
  normalizeLookupKey
} from '../toolExecutor-helpers';

// ── Re-export helpers for domain modules ─────────────────────────
export {
  DEFAULT_DOC_LIMIT,
  MAX_DOC_SCAN,
  clamp,
  excerpt,
  sanitizeFirestoreValue,
  resolveSemanticDocId,
  normalizeLookupKey
};
export { adminDb, FieldPath, FieldValue };
export { getErrorMessage };
export { normalizeFolderPath };
export { buildStoragePath, ensureTextFileName };
export { DocumentType };
export { PERSONAL_WORKSPACE_ID, isPersonalWorkspaceId };
export type {
  AgentExecutionContext,
  AgentToolCall,
  AgentToolExecutionResult,
  AgentRollbackAction
};

// ── Stored record types ──────────────────────────────────────────

export type StoredDocument = {
  id: string;
  name?: string;
  content?: string;
  type?: string;
  folder?: string;
  workspaceId?: string;
  ownerId?: string;
  mimeType?: string | null;
  storagePath?: string;
  url?: string;
  order?: number;
  size?: number;
  updatedAt?: unknown;
};

export type StoredSnippet = {
  id: string;
  title?: string;
  description?: string;
  markdown?: string;
  category?: string;
  order?: number;
  workspaceId?: string;
  ownerId?: string;
};

export type StoredBoardColumn = {
  id: string;
  name?: string;
  order?: number;
};

export type StoredBoardCard = {
  id: string;
  title?: string;
  description?: string;
  columnId?: string;
  order?: number;
  ownerId?: string;
  sourceDocId?: string | null;
  sourceDocName?: string | null;
  sourceFragment?: string | null;
  sourcePath?: string | null;
};

// ── Workspace access ─────────────────────────────────────────────

export async function ensureWorkspaceAccess(workspaceId: string, uid: string) {
  if (isPersonalWorkspaceId(workspaceId)) {
    return;
  }

  const allowed = await isWorkspaceMember(workspaceId, uid);
  if (!allowed) {
    throw new Error('No tienes acceso a este workspace');
  }
}

export async function fetchWorkspaceDoc(workspaceId: string, uid: string) {
  if (isPersonalWorkspaceId(workspaceId)) {
    return {
      id: PERSONAL_WORKSPACE_ID,
      name: 'Workspace personal',
      ownerId: uid,
      members: [uid],
      type: 'personal'
    };
  }

  const snap = await adminDb.collection('workspaces').doc(workspaceId).get();
  if (!snap.exists) {
    throw new Error('Workspace no encontrado');
  }
  return { id: snap.id, ...snap.data() } as Record<string, unknown>;
}

// ── Result builders ──────────────────────────────────────────────

export const ok = (
  call: AgentToolCall,
  summary: string,
  data: Record<string, unknown> = {},
  rollback: AgentRollbackAction[] = []
): AgentToolExecutionResult => ({
  ok: true,
  name: call.name,
  callId: call.id,
  summary,
  data,
  rollback
});

export const fail = (call: AgentToolCall, error: unknown): AgentToolExecutionResult => ({
  ok: false,
  name: call.name,
  callId: call.id,
  summary: getErrorMessage(error),
  error: getErrorMessage(error)
});

export const confirm = (
  call: AgentToolCall,
  prompt: string,
  data: Record<string, unknown> = {}
): AgentToolExecutionResult => ({
  ok: true,
  name: call.name,
  callId: call.id,
  summary: prompt,
  data,
  requiresConfirmation: true,
  pendingConfirmation: {
    toolCallId: call.id,
    toolName: call.name,
    prompt,
    args: call.args
  }
});

// ── Date / text utilities ────────────────────────────────────────

export function toEpoch(v: unknown): number {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && v !== null && 'seconds' in v) return (v as { seconds: number }).seconds * 1000;
  if (typeof v === 'string') { const d = Date.parse(v); return Number.isNaN(d) ? 0 : d; }
  return 0;
}

export function formatTimestamp(v: unknown): string | null {
  const ms = toEpoch(v);
  if (!ms) return null;
  try { return new Date(ms).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return null; }
}

export function truncateText(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 32))}\n\n[...truncado por Agora AI...]`;
}

export const containsQueryTokens = (haystack: string, queryText: string) => {
  const tokens = queryText.toLowerCase().split(/\s+/).filter((token) => token.length >= 2);
  if (tokens.length === 0) return true;
  const normalized = haystack.toLowerCase();
  return tokens.every((token) => normalized.includes(token));
};

// ── Document loading/resolving ───────────────────────────────────

export async function resolveDocumentId(
  rawId: string,
  ctx: AgentExecutionContext
): Promise<{ id: string; snapshot: FirebaseFirestore.DocumentSnapshot | null }> {
  const directSnap = await adminDb.collection('documents').doc(rawId).get();
  if (directSnap.exists) {
    return { id: rawId, snapshot: directSnap };
  }

  const nameNorm = rawId.trim().toLowerCase();
  const docsRef = adminDb.collection('documents');

  const query = isPersonalWorkspaceId(ctx.workspaceId)
    ? docsRef.where('ownerId', '==', ctx.uid).limit(MAX_DOC_SCAN)
    : docsRef.where('workspaceId', '==', ctx.workspaceId).limit(MAX_DOC_SCAN);

  const snap = await query.get();
  const matches = snap.docs.filter(d => {
    const name = (d.data().name || '').trim().toLowerCase();
    return name === nameNorm;
  });

  if (matches.length === 1) {
    const match = matches[0];
    if (match) return { id: match.id, snapshot: null };
  }

  if (matches.length === 0) {
    const partial = snap.docs.filter(d => {
      const name = (d.data().name || '').trim().toLowerCase();
      return name.includes(nameNorm) || nameNorm.includes(name);
    });
    if (partial.length === 1) {
      const match = partial[0];
      if (match) return { id: match.id, snapshot: null };
    }
    if (partial.length > 1) {
      const names = partial.slice(0, 5).map(d => `"${d.data().name}" (${d.id})`).join(', ');
      throw new Error(`Múltiples documentos coinciden con "${rawId}": ${names}. Usa el ID exacto.`);
    }
  }

  if (matches.length > 1) {
    const names = matches.slice(0, 5).map(d => `"${d.data().name}" (${d.id})`).join(', ');
    throw new Error(`Múltiples documentos con nombre "${rawId}": ${names}. Usa el ID exacto.`);
  }

  throw new Error(`Documento no encontrado: "${rawId}". Usa list_documents para ver los documentos disponibles.`);
}

export async function fetchDocumentForUser(documentId: string, ctx: AgentExecutionContext): Promise<StoredDocument> {
  const { id: resolvedId, snapshot: cachedSnap } = await resolveDocumentId(documentId, ctx);
  const snap = cachedSnap ?? await adminDb.collection('documents').doc(resolvedId).get();
  if (!snap.exists) {
    throw new Error('Documento no encontrado');
  }
  const data = { id: snap.id, ...(snap.data() as Record<string, unknown>) } as StoredDocument;
  const docWorkspaceId = data.workspaceId || PERSONAL_WORKSPACE_ID;
  if (!isPersonalWorkspaceId(docWorkspaceId)) {
    await ensureWorkspaceAccess(docWorkspaceId, ctx.uid);
  } else if (data.ownerId && data.ownerId !== ctx.uid) {
    throw new Error('No tienes acceso a este documento');
  }
  return data;
}

/**
 * Hidrata el contenido REAL del documento. La arquitectura Agora guarda en
 * Firestore solo metadata + un cache opcional de `content`; el contenido
 * canónico vive en MinIO bajo `storagePath`. Este helper:
 *   1. Si hay storagePath y es texto → lee MinIO y lo devuelve completo.
 *   2. Si no hay storagePath → devuelve doc.content (cache Firestore).
 *   3. Si MinIO falla → fallback a doc.content para no romper.
 *
 * Se usa por todas las tools que el agente invoca cuando NECESITA el texto
 * íntegro (read_document, summarize, analyze, formalize, find_broken_links,
 * find_duplicates, etc.). Antes solo leían `doc.content` y por eso el agente
 * recibía un resumen viejo cuando el doc real ya había crecido en MinIO.
 *
 * Cap: maxBytes opcional (default 1 MB) para evitar leer docs gigantes en
 * cada turno y saturar la ventana del modelo.
 */
export async function loadDocumentFullContent(
  doc: StoredDocument,
  options: { maxBytes?: number } = {}
): Promise<{ content: string; source: 'storage' | 'firestore' | 'empty'; bytesRead: number; truncated: boolean }> {
  const maxBytes = options.maxBytes ?? 1_000_000;
  const firestoreContent = typeof doc.content === 'string' ? doc.content : '';
  const isTextLike = (() => {
    const mime = (doc.mimeType || '').toLowerCase();
    if (mime && !mime.startsWith('text/') && !mime.includes('markdown') && !mime.includes('json') && !mime.includes('xml') && !mime.includes('javascript') && !mime.includes('typescript')) {
      return false;
    }
    return true;
  })();
  if (doc.storagePath && isTextLike) {
    try {
      const buf = await getObjectBuffer(doc.storagePath);
      if (buf) {
        const truncated = buf.byteLength > maxBytes;
        const slice = truncated ? buf.subarray(0, maxBytes) : buf;
        const content = slice.toString('utf8');
        return { content, source: 'storage', bytesRead: slice.byteLength, truncated };
      }
    } catch {
      // fallback a Firestore
    }
  }
  if (firestoreContent) {
    const truncated = firestoreContent.length > maxBytes;
    const sliced = truncated ? firestoreContent.slice(0, maxBytes) : firestoreContent;
    return { content: sliced, source: 'firestore', bytesRead: sliced.length, truncated };
  }
  return { content: '', source: 'empty', bytesRead: 0, truncated: false };
}

export async function loadWorkspaceDocuments(ctx: AgentExecutionContext, limit = MAX_DOC_SCAN): Promise<StoredDocument[]> {
  await ensureWorkspaceAccess(ctx.workspaceId, ctx.uid);
  let query: FirebaseFirestore.Query = adminDb.collection('documents');
  if (isPersonalWorkspaceId(ctx.workspaceId)) {
    query = query.where('ownerId', '==', ctx.uid);
    query = query.where('workspaceId', '==', PERSONAL_WORKSPACE_ID);
  } else {
    query = query.where('workspaceId', '==', ctx.workspaceId);
  }
  const snap = await query.limit(limit).get();
  return snap.docs.map(doc => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) } as StoredDocument));
}

export function summarizeDocumentMeta(doc: StoredDocument) {
  return {
    id: doc.id,
    name: doc.name || 'Sin título',
    type: doc.type || DocumentType.Text,
    folder: normalizeFolderPath(doc.folder),
    updatedAt: formatTimestamp(doc.updatedAt),
    size: typeof doc.size === 'number' ? doc.size : null,
    preview: excerpt(doc.content || '', 180)
  };
}

// ── Storage sync ─────────────────────────────────────────────────

export interface SyncTextDocumentToStorageOptions {
  docRef?: FirebaseFirestore.DocumentReference;
  source?: 'agent-create' | 'agent-update' | 'agent-restore';
  writerId?: string;
  baseVersion?: number;
  extraUpdate?: Record<string, unknown>;
}

export async function syncTextDocumentToStorage(
  doc: StoredDocument,
  content: string,
  options: SyncTextDocumentToStorageOptions = {}
): Promise<string | null> {
  try {
    const fileName = ensureTextFileName(doc.name || 'Sin titulo');
    const workspaceId = doc.workspaceId || PERSONAL_WORKSPACE_ID;
    const ownerId = doc.ownerId || 'unknown';
    const storagePath = doc.storagePath || buildStoragePath({
      workspaceId,
      ownerId,
      folder: doc.folder,
      fileName
    });

    const docRef = options.docRef ?? (doc.id ? adminDb.collection('documents').doc(doc.id) : null);
    if (docRef) {
      await writeDocumentBlob({
        docRef,
        content,
        workspaceId,
        ownerId,
        storagePath,
        contentType: doc.mimeType || 'text/markdown',
        source: options.source ?? 'agent-update',
        writerId: options.writerId ?? ownerId,
        baseVersion: options.baseVersion,
        extraUpdate: options.extraUpdate
      });
      return storagePath;
    }

    await putObject(storagePath, content, {
      contentType: doc.mimeType || 'text/markdown',
      metadata: { 'agora-source': options.source ?? 'agent-update', 'agora-owner': ownerId }
    });
    invalidateAgoraWorkspaceContext(workspaceId);
    return storagePath;
  } catch (error) {
    console.warn('Agora agent storage sync failed:', getErrorMessage(error));
    return null;
  }
}

export async function maybeDeleteStorageObject(storagePath?: string, documentId?: string) {
  if (!storagePath || !documentId) return;
  try {
    const countSnap = await adminDb.collection('documents')
      .where('storagePath', '==', storagePath)
      .where(FieldPath.documentId(), '!=', documentId)
      .count()
      .get();
    const hasOtherRefs = countSnap.data().count > 0;
    if (hasOtherRefs) return;

    await deleteObject(storagePath).catch(() => undefined);
  } catch (error) {
    console.warn('Agora agent storage delete failed:', getErrorMessage(error));
  }
}

// ── Audit log ────────────────────────────────────────────────────

export async function writeAuditLog(ctx: AgentExecutionContext, call: AgentToolCall, result: AgentToolExecutionResult) {
  try {
    await adminDb.collection('agentAuditLog').add({
      workspaceId: ctx.workspaceId,
      userId: ctx.uid,
      userEmail: ctx.email ?? null,
      toolName: call.name,
      toolArgs: sanitizeFirestoreValue(call.args),
      ok: result.ok,
      summary: result.summary,
      error: result.error ?? null,
      createdAt: FieldValue.serverTimestamp()
    });
  } catch (error) {
    console.warn('Unable to persist Agora agent audit log:', getErrorMessage(error));
  }
}

// ── Snippet loading/resolving ────────────────────────────────────

export async function listWorkspaceSnippets(ctx: AgentExecutionContext): Promise<StoredSnippet[]> {
  await ensureWorkspaceAccess(ctx.workspaceId, ctx.uid);
  let query: FirebaseFirestore.Query = adminDb.collection('snippets')
    .where('workspaceId', '==', ctx.workspaceId);
  if (isPersonalWorkspaceId(ctx.workspaceId)) {
    query = query.where('ownerId', '==', ctx.uid);
  }
  const snap = await query.limit(MAX_DOC_SCAN).get();
  return snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) } as StoredSnippet));
}

export async function resolveSnippetId(rawId: string, ctx: AgentExecutionContext): Promise<string> {
  const direct = await adminDb.collection('snippets').doc(rawId).get();
  if (direct.exists) {
    const data = direct.data() as Record<string, unknown>;
    if ((data.workspaceId || ctx.workspaceId) !== ctx.workspaceId) {
      throw new Error('Snippet fuera del workspace actual');
    }
    return rawId;
  }

  const key = normalizeLookupKey(rawId);
  const snippets = await listWorkspaceSnippets(ctx);
  const exact = snippets.filter((snippet) => normalizeLookupKey(String(snippet.title || '')) === key);
  if (exact.length === 1) {
    const match = exact[0];
    if (match) return match.id;
  }
  if (exact.length > 1) {
    throw new Error(`Múltiples snippets coinciden con "${rawId}". Usa el ID exacto.`);
  }

  const partial = snippets.filter((snippet) => {
    const title = normalizeLookupKey(String(snippet.title || ''));
    return title.includes(key) || key.includes(title);
  });
  if (partial.length === 1) {
    const match = partial[0];
    if (match) return match.id;
  }
  if (partial.length > 1) {
    throw new Error(`Múltiples snippets coinciden parcialmente con "${rawId}". Usa el ID exacto.`);
  }

  throw new Error(`Snippet no encontrado: "${rawId}".`);
}

export async function fetchSnippetForUser(snippetId: string, ctx: AgentExecutionContext): Promise<StoredSnippet> {
  const resolvedId = await resolveSnippetId(snippetId, ctx);
  const snap = await adminDb.collection('snippets').doc(resolvedId).get();
  if (!snap.exists) {
    throw new Error('Snippet no encontrado');
  }
  const data = { id: snap.id, ...(snap.data() as Record<string, unknown>) } as StoredSnippet;
  if ((data.workspaceId || ctx.workspaceId) !== ctx.workspaceId) {
    throw new Error('Snippet fuera del workspace actual');
  }
  return data;
}

// ── Worker/Nexus helpers ─────────────────────────────────────────

export const resolveWorkerWorkspaceId = (ctx: AgentExecutionContext) => {
  if (!isPersonalWorkspaceId(ctx.workspaceId)) return ctx.workspaceId;
  return ctx.workspaceId.startsWith(`${PERSONAL_WORKSPACE_ID}:`)
    ? ctx.workspaceId
    : `${PERSONAL_WORKSPACE_ID}:${ctx.uid}`;
};

export const getNexusUrl = () => (
  process.env.NEXUS_URL
  || process.env.NEXT_PUBLIC_NEXUS_URL
  || 'http://localhost:3002'
).replace(/\/+$/, '');

export async function fetchNexusJson<T>(
  path: string,
  ctx: AgentExecutionContext,
  init: RequestInit = {},
  timeoutMs = 5000
): Promise<T> {
  if (!ctx.authToken) {
    throw new Error('No hay token de usuario disponible para comunicarse con el Hub del worker.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${getNexusUrl()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.authToken}`,
        ...(init.headers || {})
      }
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) as T & { error?: string } : {} as T & { error?: string };
    if (!res.ok) {
      throw new Error(data.error || `Hub ${res.status}: ${text.slice(0, 200)}`);
    }
    return data as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchAppJson<T>(
  path: string,
  ctx: AgentExecutionContext,
  init: RequestInit = {},
  timeoutMs = 10000
): Promise<T> {
  if (!ctx.authToken) {
    throw new Error('No hay token de usuario disponible para llamar APIs internas de Agora.');
  }
  if (!ctx.origin) {
    throw new Error('No hay origin de la app disponible para llamar APIs internas de Agora.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${ctx.origin}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.authToken}`,
        ...(init.headers || {})
      }
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) as T & { error?: string; detail?: string } : {} as T & { error?: string; detail?: string };
    if (!res.ok) {
      throw new Error(data.error || data.detail || `Agora API ${res.status}: ${text.slice(0, 200)}`);
    }
    return data as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchAppSseEvents(
  path: string,
  ctx: AgentExecutionContext,
  init: RequestInit = {},
  timeoutMs = 55000
): Promise<Array<Record<string, unknown>>> {
  if (!ctx.authToken) {
    throw new Error('No hay token de usuario disponible para llamar APIs internas de Agora.');
  }
  if (!ctx.origin) {
    throw new Error('No hay origin de la app disponible para llamar APIs internas de Agora.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${ctx.origin}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.authToken}`,
        ...(init.headers || {})
      }
    });
    const text = await res.text();
    if (!res.ok) {
      try {
        const data = JSON.parse(text) as { error?: string; detail?: string };
        throw new Error(data.error || data.detail || `Agora API ${res.status}: ${text.slice(0, 200)}`);
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error(`Agora API ${res.status}: ${text.slice(0, 200)}`);
        throw error;
      }
    }

    const events: Array<Record<string, unknown>> = [];
    for (const block of text.split('\n\n')) {
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n')
        .trim();
      if (!data) continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed === 'object') events.push(parsed as Record<string, unknown>);
      } catch {
        events.push({ event: 'raw', data });
      }
    }
    return events;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchWorkerStatus(ctx: AgentExecutionContext, timeoutMs = 5000) {
  try {
    return await fetchNexusJson<{
      workspaceId: string;
      worker: { online: boolean; socketId?: string | null; workspaceType?: string; ownerId?: string | null };
      sessions: Array<{ sessionId: string; workspaceId: string; workspaceType?: string; ownerUid?: string; sessionName?: string }>;
    }>(
      `/agent/workspace-status?workspaceId=${encodeURIComponent(resolveWorkerWorkspaceId(ctx))}`,
      ctx,
      { method: 'GET' },
      timeoutMs
    );
  } catch (error) {
    return {
      workspaceId: resolveWorkerWorkspaceId(ctx),
      worker: { online: false, error: getErrorMessage(error) },
      sessions: []
    };
  }
}

// ── Semantic state ───────────────────────────────────────────────

export async function loadSemanticState(ctx: AgentExecutionContext): Promise<SemanticWorkspaceState> {
  await ensureWorkspaceAccess(ctx.workspaceId, ctx.uid);
  const storageId = resolveSemanticDocId(ctx.workspaceId, ctx.uid);
  const snap = await adminDb.collection('workspaceSemanticStates').doc(storageId).get();
  if (!snap.exists) return EMPTY_SEMANTIC_WORKSPACE_STATE;
  return normalizeSemanticWorkspaceState(snap.data());
}

// ── Board helpers ────────────────────────────────────────────────

export const DEFAULT_BOARD_COLUMNS = ['Por hacer', 'En progreso', 'Hecho'];

export const resolveBoardWorkspaceId = (workspaceId: string, uid: string) => (
  isPersonalWorkspaceId(workspaceId) ? `${PERSONAL_WORKSPACE_ID}:${uid}` : workspaceId
);

export async function ensureBoardRef(ctx: AgentExecutionContext) {
  await ensureWorkspaceAccess(ctx.workspaceId, ctx.uid);
  const boardId = resolveBoardWorkspaceId(ctx.workspaceId, ctx.uid);
  const boardRef = adminDb.collection('boards').doc(boardId);
  const snap = await boardRef.get();
  if (!snap.exists) {
    await boardRef.set({
      workspaceId: boardId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
  }

  const columnsRef = boardRef.collection('columns');
  const columnsSnap = await columnsRef.limit(1).get();
  if (columnsSnap.empty) {
    const batch = adminDb.batch();
    DEFAULT_BOARD_COLUMNS.forEach((name, index) => {
      const ref = columnsRef.doc();
      batch.set(ref, {
        name,
        order: (index + 1) * 1000,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
    });
    await batch.commit();
  }

  return boardRef;
}

export async function loadBoardState(ctx: AgentExecutionContext) {
  const boardRef = await ensureBoardRef(ctx);
  const [columnsSnap, cardsSnap] = await Promise.all([
    boardRef.collection('columns').orderBy('order').get(),
    boardRef.collection('cards').orderBy('order').get()
  ]);
  const columns = columnsSnap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) } as StoredBoardColumn));
  const cards = cardsSnap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) } as StoredBoardCard));
  return { boardRef, columns, cards };
}

export async function resolveBoardColumn(boardRef: FirebaseFirestore.DocumentReference, rawId: string): Promise<StoredBoardColumn> {
  const direct = await boardRef.collection('columns').doc(rawId).get();
  if (direct.exists) {
    return { id: direct.id, ...(direct.data() as Record<string, unknown>) } as StoredBoardColumn;
  }

  const key = normalizeLookupKey(rawId);
  const snap = await boardRef.collection('columns').orderBy('order').get();
  const columns = snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) } as StoredBoardColumn));
  const exact = columns.filter((column) => normalizeLookupKey(String(column.name || '')) === key);
  if (exact.length === 1) {
    const match = exact[0];
    if (match) return match;
  }
  if (exact.length > 1) throw new Error(`Múltiples columnas coinciden con "${rawId}".`);
  const partial = columns.filter((column) => normalizeLookupKey(String(column.name || '')).includes(key));
  if (partial.length === 1) {
    const match = partial[0];
    if (match) return match;
  }
  if (partial.length > 1) throw new Error(`Múltiples columnas coinciden parcialmente con "${rawId}".`);
  throw new Error(`Columna no encontrada: "${rawId}".`);
}

export async function resolveBoardCard(boardRef: FirebaseFirestore.DocumentReference, rawId: string): Promise<StoredBoardCard> {
  const direct = await boardRef.collection('cards').doc(rawId).get();
  if (direct.exists) {
    return { id: direct.id, ...(direct.data() as Record<string, unknown>) } as StoredBoardCard;
  }

  const key = normalizeLookupKey(rawId);
  const snap = await boardRef.collection('cards').orderBy('order').get();
  const cards = snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) } as StoredBoardCard));
  const exact = cards.filter((card) => normalizeLookupKey(String(card.title || '')) === key);
  if (exact.length === 1) {
    const match = exact[0];
    if (match) return match;
  }
  if (exact.length > 1) throw new Error(`Múltiples tarjetas coinciden con "${rawId}".`);
  const partial = cards.filter((card) => normalizeLookupKey(String(card.title || '')).includes(key));
  if (partial.length === 1) {
    const match = partial[0];
    if (match) return match;
  }
  if (partial.length > 1) throw new Error(`Múltiples tarjetas coinciden parcialmente con "${rawId}".`);
  throw new Error(`Tarjeta no encontrada: "${rawId}".`);
}

export async function loadBoardStateIfExists(ctx: AgentExecutionContext) {
  await ensureWorkspaceAccess(ctx.workspaceId, ctx.uid);
  const boardId = resolveBoardWorkspaceId(ctx.workspaceId, ctx.uid);
  const boardRef = adminDb.collection('boards').doc(boardId);
  const snap = await boardRef.get();
  if (!snap.exists) {
    return { boardRef, columns: [] as StoredBoardColumn[], cards: [] as StoredBoardCard[] };
  }
  const [columnsSnap, cardsSnap] = await Promise.all([
    boardRef.collection('columns').orderBy('order').get(),
    boardRef.collection('cards').orderBy('order').get()
  ]);
  return {
    boardRef,
    columns: columnsSnap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) } as StoredBoardColumn)),
    cards: cardsSnap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) } as StoredBoardCard))
  };
}
