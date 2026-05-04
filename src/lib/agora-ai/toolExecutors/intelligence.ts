import {
  analyzeMarkdown, compareMarkdownDocuments, summarizeMarkdown
} from '@/lib/agora-ai/documentIntelligence';
import {
  type AgentToolCall, type AgentExecutionContext, type AgentToolExecutionResult,
  ok, clamp, fetchDocumentForUser
} from './shared';

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
  const { summary, headings } = summarizeMarkdown(doc.content || '', maxSentences);
  return ok(call, `Resumí "${doc.name || 'Sin título'}".`, {
    document: { id: doc.id, name: doc.name || 'Sin título' },
    summary,
    headings: headings.slice(0, 10)
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
  const comparison = compareMarkdownDocuments(left.content || '', right.content || '');
  return ok(call, `Comparé "${left.name || 'Documento A'}" con "${right.name || 'Documento B'}".`, {
    left: { id: left.id, name: left.name || 'Documento A' },
    right: { id: right.id, name: right.name || 'Documento B' },
    comparison
  });
}

async function analyzeDocument(call: AgentToolCall, ctx: AgentExecutionContext) {
  const documentId = String(call.args.documentId || '').trim();
  if (!documentId) throw new Error('documentId es requerido');
  const doc = await fetchDocumentForUser(documentId, ctx);
  const analysis = analyzeMarkdown(doc.content || '');
  return ok(call, `Analicé "${doc.name || 'Sin título'}".`, {
    document: { id: doc.id, name: doc.name || 'Sin título' },
    analysis
  });
}

export const INTELLIGENCE_TOOL_HANDLERS: Record<string, ToolHandler> = {
  summarize_document: summarizeDocument,
  compare_documents: compareDocuments,
  analyze_document: analyzeDocument,
  fetch_url: fetchUrlTool,
  read_agora_doc: readAgoraDocTool
};
