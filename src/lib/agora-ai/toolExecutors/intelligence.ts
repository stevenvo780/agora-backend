import {
  analyzeMarkdown, compareMarkdownDocuments, summarizeMarkdown
} from '@/lib/agora-ai/documentIntelligence';
import {
  type AgentToolCall, type AgentExecutionContext, type AgentToolExecutionResult,
  ok, confirm, clamp, fetchDocumentForUser, loadDocumentFullContent,
  loadWorkspaceDocumentsPage, DEFAULT_PAGE_SIZE, buildPageMeta, resolvePageSize,
  resolveSnippetId, adminDb, FieldValue, DocumentType,
  containsQueryTokens,
  type StoredDocument
} from './shared';
import { expandSubgraph, loadWorkspaceDocMetaIndex } from '@/lib/citations/graph-store';
import { isCitationKind, type CitationKind } from '@/lib/citations/types';
import { fuzzyResolveDocId, type ResolvedDocRef } from '@/lib/citations/resolveDoc';

const FETCH_URL_MAX_BYTES_DEFAULT = 50_000;
const FETCH_URL_MAX_BYTES_HARD = 200_000;
const FETCH_URL_TIMEOUT_DEFAULT_MS = 8_000;
const FETCH_URL_TIMEOUT_HARD_MS = 30_000;
const FETCH_URL_BLOCKED_HOSTNAMES = new Set([
  'localhost', '0.0.0.0', '::1',
  'metadata.google.internal', 'metadata.goog'
]);
const FETCH_URL_BLOCKED_HOST_REGEX = /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[0-1])\.)/;

const AGORA_DOC_BASE = 'https://agora.elenxos.com/docs';
const AGORA_DOC_ALLOWED_SLUGS = new Set([
  'st',
  'st/proposicional', 'st/primer-orden', 'st/modal-k', 'st/modal-t', 'st/modal-s4', 'st/modal-s5',
  'st/deontico', 'st/epistemico', 'st/intuicionista', 'st/temporal-ltl',
  'st/belnap', 'st/silogistico', 'st/probabilistico', 'st/aritmetico'
]);

function validateExternalUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`URL inválida: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Protocolo no permitido: ${url.protocol} (sólo http/https)`);
  }
  const host = url.hostname.toLowerCase();
  if (FETCH_URL_BLOCKED_HOSTNAMES.has(host)) {
    throw new Error(`Host bloqueado: ${host}`);
  }
  if (FETCH_URL_BLOCKED_HOST_REGEX.test(host)) {
    throw new Error(`Host privado/local bloqueado: ${host}`);
  }
  return url;
}

async function fetchUrlText(url: URL, maxBytes: number, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'agora-agent/1.0', Accept: 'text/html, text/plain, application/json;q=0.9, */*;q=0.5' }
    });
    const reader = res.body?.getReader();
    if (!reader) {
      const text = await res.text();
      const truncated = text.length > maxBytes;
      return {
        status: res.status,
        contentType: res.headers.get('content-type') || '',
        bodyText: text.slice(0, maxBytes),
        bytesRead: text.length,
        truncated
      };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      const slice = value.byteLength <= remaining ? value : value.slice(0, remaining);
      chunks.push(slice);
      total += slice.byteLength;
      if (value.byteLength > remaining) break;
    }
    try { void reader.cancel(); } catch { /* noop */ }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
    const bodyText = new TextDecoder('utf-8', { fatal: false }).decode(merged);
    const contentLength = Number(res.headers.get('content-length') || '0');
    const truncated = total >= maxBytes && (!contentLength || contentLength > total);
    return {
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      bodyText,
      bytesRead: total,
      truncated
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUrlTool(call: AgentToolCall, _ctx: AgentExecutionContext) {
  const rawUrl = String(call.args.url || '').trim();
  if (!rawUrl) throw new Error('url es requerida');
  const url = validateExternalUrl(rawUrl);
  const maxBytes = clamp(
    typeof call.args.maxBytes === 'number' ? call.args.maxBytes : FETCH_URL_MAX_BYTES_DEFAULT,
    1024, FETCH_URL_MAX_BYTES_HARD
  );
  const timeoutMs = clamp(
    typeof call.args.timeoutMs === 'number' ? call.args.timeoutMs : FETCH_URL_TIMEOUT_DEFAULT_MS,
    1000, FETCH_URL_TIMEOUT_HARD_MS
  );
  const result = await fetchUrlText(url, maxBytes, timeoutMs);
  const summary = result.truncated
    ? `${result.status} ${url.host} (${result.bytesRead} bytes, truncado)`
    : `${result.status} ${url.host} (${result.bytesRead} bytes)`;
  return ok(call, summary, {
    url: url.toString(),
    status: result.status,
    contentType: result.contentType,
    bodyText: result.bodyText,
    bytesRead: result.bytesRead,
    truncated: result.truncated
  });
}

async function readAgoraDocTool(call: AgentToolCall, ctx: AgentExecutionContext) {
  const slug = String(call.args.slug || '').trim().replace(/^\/+|\/+$/g, '');
  if (!slug) {
    return ok(call, `Doc slugs disponibles: ${Array.from(AGORA_DOC_ALLOWED_SLUGS).join(', ')}`, {
      availableSlugs: Array.from(AGORA_DOC_ALLOWED_SLUGS)
    });
  }
  if (!AGORA_DOC_ALLOWED_SLUGS.has(slug)) {
    throw new Error(`slug "${slug}" no está en la lista permitida. Slugs válidos: ${Array.from(AGORA_DOC_ALLOWED_SLUGS).join(', ')}`);
  }
  const url = validateExternalUrl(`${AGORA_DOC_BASE}/${slug}`);
  const maxBytes = clamp(
    typeof call.args.maxBytes === 'number' ? call.args.maxBytes : 80_000,
    1024, FETCH_URL_MAX_BYTES_HARD
  );
  const result = await fetchUrlText(url, maxBytes, FETCH_URL_TIMEOUT_DEFAULT_MS);
  void ctx;
  return ok(call, `Doc Agora /${slug} (${result.bytesRead} bytes${result.truncated ? ', truncado' : ''})`, {
    slug,
    url: url.toString(),
    status: result.status,
    contentType: result.contentType,
    bodyText: result.bodyText,
    bytesRead: result.bytesRead,
    truncated: result.truncated
  });
}

type ToolHandler = (call: AgentToolCall, ctx: AgentExecutionContext) => Promise<AgentToolExecutionResult>;

async function summarizeDocument(call: AgentToolCall, ctx: AgentExecutionContext) {
  const documentId = String(call.args.documentId || '').trim();
  if (!documentId) throw new Error('documentId es requerido');
  const doc = await fetchDocumentForUser(documentId, ctx);
  const maxSentences = clamp(typeof call.args.maxSentences === 'number' ? call.args.maxSentences : 4, 1, 8);
  const hydrated = await loadDocumentFullContent(doc);
  const { summary, headings } = summarizeMarkdown(hydrated.content, maxSentences);
  return ok(call, `Resumí "${doc.name || 'Sin título'}" (${hydrated.bytesRead} bytes desde ${hydrated.source}).`, {
    document: { id: doc.id, name: doc.name || 'Sin título' },
    summary,
    headings: headings.slice(0, 10),
    contentSource: hydrated.source
  });
}

async function compareDocuments(call: AgentToolCall, ctx: AgentExecutionContext) {
  const leftDocumentId = String(call.args.leftDocumentId || '').trim();
  const rightDocumentId = String(call.args.rightDocumentId || '').trim();
  if (!leftDocumentId || !rightDocumentId) throw new Error('leftDocumentId y rightDocumentId son requeridos');
  const [left, right] = await Promise.all([
    fetchDocumentForUser(leftDocumentId, ctx),
    fetchDocumentForUser(rightDocumentId, ctx)
  ]);
  const [leftHydrated, rightHydrated] = await Promise.all([
    loadDocumentFullContent(left),
    loadDocumentFullContent(right)
  ]);
  const comparison = compareMarkdownDocuments(leftHydrated.content, rightHydrated.content);
  return ok(call, `Comparé "${left.name || 'Documento A'}" con "${right.name || 'Documento B'}".`, {
    left: { id: left.id, name: left.name || 'Documento A', contentSource: leftHydrated.source },
    right: { id: right.id, name: right.name || 'Documento B', contentSource: rightHydrated.source },
    comparison
  });
}

async function analyzeDocument(call: AgentToolCall, ctx: AgentExecutionContext) {
  const documentId = String(call.args.documentId || '').trim();
  if (!documentId) throw new Error('documentId es requerido');
  const doc = await fetchDocumentForUser(documentId, ctx);
  const hydrated = await loadDocumentFullContent(doc);
  const analysis = analyzeMarkdown(hydrated.content);
  return ok(call, `Analicé "${doc.name || 'Sin título'}" (${hydrated.bytesRead} bytes desde ${hydrated.source}).`, {
    document: { id: doc.id, name: doc.name || 'Sin título' },
    analysis,
    contentSource: hydrated.source
  });
}

function parseMarkdownHeadings(content: string) {
  const lines = content.split('\n');
  const headings: Array<{ level: number; text: string; line: number }> = [];
  let inFence = false;
  let fenceMarker = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const fenceMatch = line.match(/^(```|~~~)/);
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1];
      if (!inFence) { inFence = true; fenceMarker = marker; }
      else if (line.startsWith(fenceMarker)) { inFence = false; fenceMarker = ''; }
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m?.[1] && m[2]) headings.push({ level: m[1].length, text: m[2].trim(), line: i + 1 });
  }
  return headings;
}

async function outlineDocumentTool(call: AgentToolCall, ctx: AgentExecutionContext) {
  const documentId = String(call.args.documentId || '').trim();
  if (!documentId) throw new Error('documentId es requerido');
  const doc = await fetchDocumentForUser(documentId, ctx);
  const hydrated = await loadDocumentFullContent(doc);
  const headings = parseMarkdownHeadings(hydrated.content);
  return ok(call, `Esquema: ${headings.length} encabezado(s).`, {
    document: { id: doc.id, name: doc.name || 'Sin título' },
    headings,
    contentSource: hydrated.source
  });
}

async function findBrokenLinksTool(call: AgentToolCall, ctx: AgentExecutionContext) {
  const documentId = String(call.args.documentId || '').trim();
  if (!documentId) throw new Error('documentId es requerido');
  const doc = await fetchDocumentForUser(documentId, ctx);
  const hydrated = await loadDocumentFullContent(doc);
  const content = hydrated.content;
  const linkRegex = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const allLinks: Array<{ text: string; href: string; line: number }> = [];
  const lines = content.split('\n');
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(content)) !== null) {
    const before = content.slice(0, match.index);
    const lineNum = (before.match(/\n/g)?.length ?? 0) + 1;
    allLinks.push({ text: match[1] || '', href: match[2] || '', line: lineNum });
  }
  void lines;
  const pageSize = resolvePageSize(call.args.pageSize, DEFAULT_PAGE_SIZE);
  const cursor = typeof call.args.cursor === 'string' ? call.args.cursor : null;
  const page = await loadWorkspaceDocumentsPage(ctx, { limit: pageSize, cursor });
  const docs = page.documents;
  const docNames = new Set(docs.map(d => (d.name || '').toLowerCase()));
  const docPaths = new Set(docs.map(d => `${d.folder ? d.folder + '/' : ''}${d.name || ''}`.toLowerCase()));
  const broken: typeof allLinks = [];
  for (const link of allLinks) {
    const href = link.href.trim();
    if (!href) continue;
    if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href) || href.startsWith('#')) continue;
    const normalized = href.replace(/^\.?\//, '').toLowerCase();
    if (!docNames.has(normalized) && !docPaths.has(normalized)) broken.push(link);
  }
  const pageMeta = buildPageMeta(page.scannedThisPage, page.nextCursor);
  const continuationNote = pageMeta.hasMore
    ? ' (página parcial; itera con cursor — pueden existir docs target en páginas siguientes)'
    : '';
  return ok(call, `Encontré ${allLinks.length} enlace(s); ${broken.length} parecen rotos (no apuntan a ningún doc del workspace ni son URL externa)${continuationNote}.`, {
    document: { id: doc.id, name: doc.name || 'Sin título' },
    totalLinks: allLinks.length,
    brokenLinks: broken,
    page: pageMeta
  });
}

function quickHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return hash.toString(36);
}

function shingles(text: string, size = 5): Set<string> {
  const tokens = text.toLowerCase().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + size <= tokens.length; i += 1) out.add(tokens.slice(i, i + size).join(' '));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const v of a) if (b.has(v)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Encuentra duplicados procesando UNA página por llamada. El agente itera
 * `nextCursor` y agrega los duplicados encontrados en cada página.
 *
 * Para detectar duplicados cross-page, el caller debe pasar el state previo
 * en `prevState` (devuelto por la llamada anterior). Esto preserva el
 * shingle-bucket entre páginas sin recargar Firestore.
 *
 * No hay cap duro. Si el agente quiere escanear 100k docs, itera 50 páginas.
 */
async function findDuplicatesTool(call: AgentToolCall, ctx: AgentExecutionContext) {
  const minSimilarity = clamp(typeof call.args.minSimilarity === 'number' ? call.args.minSimilarity : 0.6, 0.1, 1);
  const confirmed = call.args.confirm === true || call.args.confirmed === true;
  const pageSize = resolvePageSize(call.args.pageSize, DEFAULT_PAGE_SIZE);
  const cursor = typeof call.args.cursor === 'string' ? call.args.cursor : null;
  const isFirstPage = cursor === null;

  if (!confirmed && isFirstPage) {
    return ok(call, `find_duplicates requiere confirmación. Procesa el workspace en páginas de hasta ${pageSize} doc(s) cada una. Llama de nuevo con confirm:true (opcional pageSize, cursor para iterar).`, {
      requiresConfirmation: true,
      pageSize,
      minSimilarity,
      hint: 'pre-filtro por shingle-overlap reduce drásticamente los pares jaccard reales. Itera nextCursor para escanear todo el workspace.'
    });
  }

  const page = await loadWorkspaceDocumentsPage(ctx, { limit: pageSize, cursor });
  const textDocs = page.documents.filter((d: StoredDocument) => (d.type || DocumentType.Text) !== DocumentType.Folder);

  const hydrated = await Promise.all(textDocs.map(async (d) => {
    const h = await loadDocumentFullContent(d, { maxBytes: 200_000 });
    return { id: d.id, name: d.name || 'Sin título', content: h.content };
  }));
  const fingerprints = hydrated.filter(d => d.content.length >= 50).map((d) => ({
    id: d.id, name: d.name,
    hash: quickHash(d.content),
    shingles: shingles(d.content)
  }));

  const exactMatches: Array<{ aId: string; bId: string; aName: string; bName: string }> = [];
  const seenHashes = new Map<string, typeof fingerprints[0]>();
  for (const fp of fingerprints) {
    const prev = seenHashes.get(fp.hash);
    if (prev) exactMatches.push({ aId: prev.id, bId: fp.id, aName: prev.name, bName: fp.name });
    else seenHashes.set(fp.hash, fp);
  }

  const shingleBucket = new Map<string, number[]>();
  for (let i = 0; i < fingerprints.length; i += 1) {
    const fp = fingerprints[i]!;
    for (const s of fp.shingles) {
      let bucket = shingleBucket.get(s);
      if (!bucket) { bucket = []; shingleBucket.set(s, bucket); }
      bucket.push(i);
    }
  }
  const candidatePairs = new Set<string>();
  for (const bucket of shingleBucket.values()) {
    if (bucket.length < 2) continue;
    for (let a = 0; a < bucket.length; a += 1) {
      for (let b = a + 1; b < bucket.length; b += 1) {
        const i = bucket[a]!;
        const j = bucket[b]!;
        candidatePairs.add(i < j ? `${i}:${j}` : `${j}:${i}`);
      }
    }
  }

  const similarPairs: Array<{ aId: string; bId: string; aName: string; bName: string; similarity: number }> = [];
  for (const key of candidatePairs) {
    const sep = key.indexOf(':');
    const i = Number(key.slice(0, sep));
    const j = Number(key.slice(sep + 1));
    const a = fingerprints[i]!;
    const b = fingerprints[j]!;
    if (a.hash === b.hash) continue;
    const sim = jaccard(a.shingles, b.shingles);
    if (sim >= minSimilarity) similarPairs.push({ aId: a.id, bId: b.id, aName: a.name, bName: b.name, similarity: Math.round(sim * 100) / 100 });
  }
  similarPairs.sort((p, q) => q.similarity - p.similarity);

  const pageMeta = buildPageMeta(page.scannedThisPage, page.nextCursor);
  const continuationNote = pageMeta.hasMore
    ? ` Itera con cursor para procesar más páginas — los duplicados cross-page se detectan re-llamando con el mismo minSimilarity.`
    : '';

  return ok(call, `Página ${page.scannedThisPage} doc(s): ${exactMatches.length} duplicado(s) exacto(s), ${similarPairs.length} par(es) similares (≥${minSimilarity}). ${fingerprints.length} fingerprints, ${candidatePairs.size} par(es) evaluados.${continuationNote}`, {
    documentCount: fingerprints.length,
    candidatePairsEvaluated: candidatePairs.size,
    exactDuplicates: exactMatches,
    similarPairs: similarPairs.slice(0, 50),
    page: pageMeta,
    minSimilarity
  });
}

async function applySnippetToDocumentTool(call: AgentToolCall, ctx: AgentExecutionContext) {
  const documentId = String(call.args.documentId || '').trim();
  const snippetId = String(call.args.snippetId || '').trim();
  const position = String(call.args.position || 'end').trim();
  const confirmed = call.args.confirmed === true;
  if (!documentId || !snippetId) throw new Error('documentId y snippetId son requeridos');
  if (!['start', 'end', 'cursor'].includes(position)) throw new Error('position debe ser start|end|cursor');

  const doc = await fetchDocumentForUser(documentId, ctx);
  const resolvedSnippetId = await resolveSnippetId(snippetId, ctx);
  const snippetSnap = await adminDb.collection('snippets').doc(resolvedSnippetId).get();
  if (!snippetSnap.exists) throw new Error('Snippet no encontrado');
  const snippet = snippetSnap.data() as Record<string, unknown>;
  const snippetText = String(snippet.markdown || snippet.description || '');

  const hydrated = await loadDocumentFullContent(doc);
  const previousContent = hydrated.content;
  const newContent = position === 'start'
    ? `${snippetText}\n\n${previousContent}`
    : `${previousContent}\n\n${snippetText}`;

  if (!confirmed) {
    return confirm(call, `¿Insertar el snippet "${String(snippet.title || 'Sin título')}" (${snippetText.length} bytes) ${position === 'start' ? 'al inicio' : 'al final'} de "${doc.name || 'Sin título'}"?`, {
      documentId: doc.id, snippetId: resolvedSnippetId, position
    });
  }

  await adminDb.collection('documents').doc(doc.id).update({
    content: newContent,
    updatedAt: FieldValue.serverTimestamp(),
    lastUpdatedBy: ctx.uid
  });

  return ok(call, `Inserté snippet "${String(snippet.title || 'Sin título')}" en "${doc.name || 'Sin título'}".`, {
    document: { id: doc.id, name: doc.name || 'Sin título' },
    snippet: { id: resolvedSnippetId, title: snippet.title || 'Sin título' },
    position,
    newContentLength: newContent.length
  }, [{ action: 'update_document', args: { documentId: doc.id, content: previousContent, confirmed: true } }]);
}

async function extractTextFromPdf(call: AgentToolCall, ctx: AgentExecutionContext) {
  const documentId = String(call.args.documentId || '').trim();
  if (!documentId) throw new Error('documentId es requerido');
  const doc = await fetchDocumentForUser(documentId, ctx);
  const isPdf = (doc.mimeType || '').toLowerCase().includes('pdf') || (doc.name || '').toLowerCase().endsWith('.pdf');
  if (!isPdf) throw new Error(`El documento "${doc.name || 'Sin título'}" no parece un PDF (mimeType=${doc.mimeType || 'desconocido'})`);
  if (!doc.storagePath) {
    return ok(call, `El PDF "${doc.name}" no tiene storagePath; probablemente fue subido como text fallback.`, { documentId, notImplementedFully: true });
  }
  const { getObjectBuffer } = await import('@/lib/nas-storage');
  const buf = await getObjectBuffer(doc.storagePath);
  if (!buf) throw new Error('No se pudo descargar el PDF de MinIO');
  const pdfParseModule = await import('pdf-parse');
  const pdfParse = (pdfParseModule as { default?: (data: Buffer) => Promise<{ text?: string; numpages?: number }> }).default
    ?? (pdfParseModule as unknown as (data: Buffer) => Promise<{ text?: string; numpages?: number }>);
  const result = await pdfParse(buf);
  const text = (result.text || '').slice(0, 200_000);
  return ok(call, `Extraje texto del PDF "${doc.name}" (${result.numpages || '?'} páginas, ${text.length} chars).`, {
    document: { id: doc.id, name: doc.name },
    pages: result.numpages || null,
    text
  });
}

async function lintStDocument(call: AgentToolCall, ctx: AgentExecutionContext) {
  const documentId = String(call.args.documentId || '').trim();
  if (!documentId) throw new Error('documentId es requerido');
  const doc = await fetchDocumentForUser(documentId, ctx);
  const hydrated = await loadDocumentFullContent(doc);
  if (!hydrated.content.trim()) {
    return ok(call, `"${doc.name || 'Sin título'}" está vacío.`, { findings: [] });
  }
  const stLib = await import('@/lib/st-api');
  const { collectSTDiagnostics } = await import('@/lib/st-execution');
  try {
    const result = stLib.evaluate(hydrated.content);
    const diagnostics = collectSTDiagnostics(result);
    return ok(call, `Lint ST "${doc.name}": ${diagnostics.length} diagnóstico(s).`, {
      document: { id: doc.id, name: doc.name || 'Sin título' },
      diagnostics,
      programOk: result.ok
    });
  } catch (error) {
    return ok(call, `Falló al ejecutar el ST runtime: ${error instanceof Error ? error.message : String(error)}`, {
      documentId, parseError: true
    });
  }
}

async function semanticSearchWorkspaceStub(call: AgentToolCall, _ctx: AgentExecutionContext) {
  return ok(call, 'Búsqueda semántica vectorial no implementada — Agora aún no genera embeddings de documentos. Usa `search_workspace` para búsqueda por tokens; añadir embeddings requiere OpenAI/Gemini embeddings + vector store (decisión de producto).', {
    notImplementedFully: true,
    suggestion: 'usar search_workspace o search_documents'
  });
}

const normalizeKindsArg = (raw: unknown): CitationKind[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const out: CitationKind[] = [];
  for (const item of raw) {
    if (isCitationKind(item)) out.push(item);
  }
  return out.length > 0 ? out : undefined;
};

const normalizeDocIdsArg = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim().length > 0) out.push(item.trim());
  }
  return out;
};

interface ResolvedDocEntry {
  actualDocId: string;
  originalInput: string;
  resolvedFromAmbiguousInput: boolean;
  matchedBy: ResolvedDocRef['matchedBy'];
}

/**
 * Resuelve una lista de inputs (docId exacto, nombre, slug, texto parcial)
 * a IDs reales de Firestore. Usa fuzzyResolveDocId para ser permisivo con
 * inputs ambiguos del agente IA.
 */
const resolveDocIdsForCtxDetailed = async (
  ids: string[],
  ctx: AgentExecutionContext
): Promise<ResolvedDocEntry[]> => {
  const resolved: ResolvedDocEntry[] = [];
  for (const raw of ids) {
    const ref = await fuzzyResolveDocId(raw, ctx.workspaceId, ctx.uid);
    if (ref) {
      resolved.push({
        actualDocId: ref.actualDocId,
        originalInput: raw,
        resolvedFromAmbiguousInput: ref.resolvedFromAmbiguousInput,
        matchedBy: ref.matchedBy
      });
    }
  }
  return resolved;
};

/** Compat: devuelve sólo los IDs (para find_related_via_graph y expand_context). */
const resolveDocIdsForCtx = async (ids: string[], ctx: AgentExecutionContext): Promise<string[]> => {
  const entries = await resolveDocIdsForCtxDetailed(ids, ctx);
  return entries.map((e) => e.actualDocId);
};

async function queryCitationGraphTool(call: AgentToolCall, ctx: AgentExecutionContext) {
  const focusRaw = normalizeDocIdsArg(call.args.focusDocIds);
  if (focusRaw.length === 0) throw new Error('focusDocIds es requerido (array de IDs o nombres)');
  const depth = clamp(typeof call.args.depth === 'number' ? call.args.depth : 1, 1, 3);
  const kinds = normalizeKindsArg(call.args.kinds);

  const focusEntries = await resolveDocIdsForCtxDetailed(focusRaw, ctx);
  if (focusEntries.length === 0) {
    const inputs = focusRaw.map((s) => `"${s}"`).join(', ');
    throw new Error(
      `No encontré un doc que coincida con ${inputs}. ` +
      '¿Querés probar con otro nombre o pasar el docId directo? ' +
      'Podés usar list_documents para ver los documentos disponibles.'
    );
  }

  const focus = focusEntries.map((e) => e.actualDocId);
  const subgraph = await expandSubgraph({
    workspaceId: ctx.workspaceId,
    uid: ctx.uid,
    focusDocIds: focus,
    depth,
    ...(kinds ? { kinds } : {})
  });

  const ambiguous = focusEntries.filter((e) => e.resolvedFromAmbiguousInput);
  const resolutionHints = ambiguous.map((e) => ({
    originalInput: e.originalInput,
    actualDocId: e.actualDocId,
    matchedBy: e.matchedBy
  }));

  const summary = `Subgrafo: ${subgraph.nodes.length} nodo(s), ${subgraph.edges.length} arista(s) (depth=${depth}${kinds ? `, kinds=${kinds.join(',')}` : ''})${subgraph.truncated ? ' [truncado por hard cap]' : ''}${ambiguous.length > 0 ? ` [${ambiguous.length} input(s) resuelto(s) por nombre/slug/fuzzy]` : ''}.`;
  return ok(call, summary, {
    nodes: subgraph.nodes,
    edges: subgraph.edges,
    focus: subgraph.focus,
    depth: subgraph.depth,
    truncated: subgraph.truncated,
    ...(ambiguous.length > 0 ? { resolvedFromAmbiguousInput: true, resolutionHints } : {})
  });
}

const lexicalScore = (haystack: string, queryTokens: string[]): number => {
  if (queryTokens.length === 0) return 0;
  const normalized = haystack.toLowerCase();
  let hits = 0;
  let effective = 0;
  for (const token of queryTokens) {
    if (token.length < 2) continue;
    effective += 1;
    if (normalized.includes(token)) hits += 1;
  }
  return effective === 0 ? 0 : hits / effective;
};

async function findRelatedViaGraphTool(call: AgentToolCall, ctx: AgentExecutionContext) {
  const query = String(call.args.query || '').trim();
  if (!query) throw new Error('query es requerido');
  const limit = clamp(typeof call.args.limit === 'number' ? call.args.limit : 15, 1, 50);
  const seedRaw = typeof call.args.seedDocId === 'string' && call.args.seedDocId.trim().length > 0
    ? call.args.seedDocId.trim()
    : null;

  const metaIndex = await loadWorkspaceDocMetaIndex(ctx.workspaceId, ctx.uid);
  const queryTokens = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);

  const lexicalCandidates: Array<{ docId: string; name: string; score: number }> = [];
  for (const [docId, meta] of metaIndex.entries()) {
    if (meta.type === DocumentType.Folder) continue;
    const haystack = `${meta.name} ${meta.folder ?? ''}`;
    const score = lexicalScore(haystack, queryTokens);
    if (score > 0) lexicalCandidates.push({ docId, name: meta.name, score });
  }
  lexicalCandidates.sort((a, b) => b.score - a.score);

  const lexicalSeeds = lexicalCandidates.slice(0, 10).map((c) => c.docId);
  let seedFromArg: string | null = null;
  if (seedRaw) {
    try {
      const doc = await fetchDocumentForUser(seedRaw, ctx);
      seedFromArg = doc.id;
    } catch {
      seedFromArg = null;
    }
  }
  const seeds = Array.from(new Set([
    ...(seedFromArg ? [seedFromArg] : []),
    ...lexicalSeeds
  ]));

  let graphNodes: Array<{ docId: string; depth: number }> = [];
  if (seeds.length > 0) {
    const subgraph = await expandSubgraph({
      workspaceId: ctx.workspaceId,
      uid: ctx.uid,
      focusDocIds: seeds,
      depth: 2,
      docMetaIndex: metaIndex
    });
    graphNodes = subgraph.nodes.map((n) => ({ docId: n.docId, depth: n.depth }));
  }
  const graphDepthByDoc = new Map<string, number>();
  for (const n of graphNodes) {
    const prev = graphDepthByDoc.get(n.docId);
    if (prev === undefined || n.depth < prev) graphDepthByDoc.set(n.docId, n.depth);
  }

  const lexicalMap = new Map<string, number>();
  for (const c of lexicalCandidates) lexicalMap.set(c.docId, c.score);

  const allDocIds = new Set<string>([...lexicalMap.keys(), ...graphDepthByDoc.keys()]);
  const scored: Array<{ docId: string; name: string; folder?: string | null; lexicalScore: number; graphDepth: number | null; combinedScore: number }> = [];
  for (const docId of allDocIds) {
    const meta = metaIndex.get(docId);
    if (!meta) continue;
    if (meta.type === DocumentType.Folder) continue;
    const lex = lexicalMap.get(docId) ?? 0;
    const depth = graphDepthByDoc.get(docId);
    const graphBoost = depth === undefined ? 0 : 1 / (1 + depth);
    const combined = lex * 0.6 + graphBoost * 0.4;
    if (combined <= 0) continue;
    scored.push({
      docId,
      name: meta.name,
      folder: meta.folder ?? null,
      lexicalScore: Number(lex.toFixed(3)),
      graphDepth: depth ?? null,
      combinedScore: Number(combined.toFixed(3))
    });
  }
  scored.sort((a, b) => b.combinedScore - a.combinedScore);
  const results = scored.slice(0, limit);

  return ok(call, `Encontré ${results.length} doc(s) relevantes (lexical+grafo).`, {
    query,
    results,
    seedDocIds: seeds,
    totalCandidates: allDocIds.size
  });
}

async function expandContextTool(call: AgentToolCall, ctx: AgentExecutionContext) {
  const initialRaw = normalizeDocIdsArg(call.args.initialDocIds);
  if (initialRaw.length === 0) throw new Error('initialDocIds es requerido');
  const hops = clamp(typeof call.args.hops === 'number' ? call.args.hops : 1, 1, 2);
  const initial = await resolveDocIdsForCtx(initialRaw, ctx);
  if (initial.length === 0) throw new Error('Ningún initialDocId pudo resolverse.');

  const subgraph = await expandSubgraph({
    workspaceId: ctx.workspaceId,
    uid: ctx.uid,
    focusDocIds: initial,
    depth: hops
  });

  const edgeWeightByDoc = new Map<string, number>();
  for (const edge of subgraph.edges) {
    const sourceIsInitial = initial.includes(edge.from);
    const targetIsInitial = initial.includes(edge.to);
    const otherDoc = sourceIsInitial ? edge.to : targetIsInitial ? edge.from : null;
    if (!otherDoc || initial.includes(otherDoc)) continue;
    edgeWeightByDoc.set(otherDoc, (edgeWeightByDoc.get(otherDoc) ?? 0) + edge.weight);
  }

  const enriched = subgraph.nodes
    .filter((n) => !initial.includes(n.docId))
    .map((n) => ({
      docId: n.docId,
      name: n.name,
      folder: n.folder ?? null,
      hopsFromInitial: n.depth,
      incidentEdgeWeight: edgeWeightByDoc.get(n.docId) ?? 0
    }))
    .sort((a, b) => {
      if (a.hopsFromInitial !== b.hopsFromInitial) return a.hopsFromInitial - b.hopsFromInitial;
      return b.incidentEdgeWeight - a.incidentEdgeWeight;
    });

  void containsQueryTokens;
  return ok(call, `Contexto expandido: ${enriched.length} doc(s) conectado(s) en hasta ${hops} salto(s).`, {
    initialDocIds: initial,
    hops,
    relatedDocs: enriched,
    truncated: subgraph.truncated
  });
}

export const INTELLIGENCE_TOOL_HANDLERS: Record<string, ToolHandler> = {
  summarize_document: summarizeDocument,
  compare_documents: compareDocuments,
  analyze_document: analyzeDocument,
  fetch_url: fetchUrlTool,
  read_agora_doc: readAgoraDocTool,
  outline_document: outlineDocumentTool,
  find_broken_links: findBrokenLinksTool,
  find_duplicates: findDuplicatesTool,
  apply_snippet_to_document: applySnippetToDocumentTool,
  extract_text_from_pdf: extractTextFromPdf,
  lint_st_document: lintStDocument,
  semantic_search_workspace: semanticSearchWorkspaceStub,
  query_citation_graph: queryCitationGraphTool,
  find_related_via_graph: findRelatedViaGraphTool,
  expand_context: expandContextTool
};
