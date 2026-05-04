import {
  analyzeMarkdown, compareMarkdownDocuments, summarizeMarkdown
} from '@/lib/agora-ai/documentIntelligence';
import {
  type AgentToolCall, type AgentExecutionContext, type AgentToolExecutionResult,
  ok, clamp, fetchDocumentForUser
} from './shared';

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
  analyze_document: analyzeDocument
};
