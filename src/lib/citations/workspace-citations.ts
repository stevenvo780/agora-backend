import { adminDb } from '@/lib/firebase-admin';
import { isPersonalWorkspaceId, PERSONAL_WORKSPACE_ID } from '@/types/workspace';
import {
  normalizeSemanticWorkspaceState,
  type SemanticConceptRecord,
  type SemanticFragmentRecord
} from '@/lib/semantic/workspace-state';
import { buildBibKeyIndex, parseCitations, type WorkspaceDocRef } from './parser';
import { loadWorkspaceDocMetaIndex, writeCitationsForDoc, type DocMetaForGraph } from './graph-store';
import type { CitationEdge, CitationKind } from './types';
import { isCitationKind } from './types';

interface CachedWorkspaceDocs {
  builtAt: number;
  docs: Map<string, WorkspaceDocRef>;
  bibIndex: Map<string, string>;
  meta: Map<string, DocMetaForGraph>;
}

const WORKSPACE_INDEX_CACHE_TTL_MS = 60_000;
const workspaceIndexCache = new Map<string, CachedWorkspaceDocs>();

const cacheKey = (workspaceId: string, uid?: string): string => (
  isPersonalWorkspaceId(workspaceId) ? `${PERSONAL_WORKSPACE_ID}::${uid ?? 'shared'}` : workspaceId
);

export const invalidateWorkspaceCitationIndex = (workspaceId: string, uid?: string): void => {
  workspaceIndexCache.delete(cacheKey(workspaceId, uid));
};

export const getWorkspaceCitationIndex = async (
  workspaceId: string,
  uid?: string
): Promise<CachedWorkspaceDocs> => {
  const key = cacheKey(workspaceId, uid);
  const cached = workspaceIndexCache.get(key);
  const now = Date.now();
  if (cached && now - cached.builtAt < WORKSPACE_INDEX_CACHE_TTL_MS) {
    return cached;
  }
  const meta = await loadWorkspaceDocMetaIndex(workspaceId, uid);
  const docs = new Map<string, WorkspaceDocRef>();
  const refs: WorkspaceDocRef[] = [];
  for (const [id, m] of meta.entries()) {
    const ref: WorkspaceDocRef = { id, name: m.name, folder: m.folder ?? null };
    docs.set(id, ref);
    refs.push(ref);
  }
  try {
    const docsSnap = await adminDb.collection('documents')
      .where('workspaceId', '==', isPersonalWorkspaceId(workspaceId) ? PERSONAL_WORKSPACE_ID : workspaceId)
      .select('storagePath')
      .get();
    for (const doc of docsSnap.docs) {
      const existing = docs.get(doc.id);
      if (!existing) continue;
      const sp = (doc.data() as { storagePath?: unknown }).storagePath;
      if (typeof sp === 'string') existing.storagePath = sp;
    }
  } catch (err) {
    console.warn('[citations] storagePath enrich failed:', err instanceof Error ? err.message : err);
  }
  const bibIndex = buildBibKeyIndex(refs);
  const entry: CachedWorkspaceDocs = { builtAt: now, docs, bibIndex, meta };
  workspaceIndexCache.set(key, entry);
  return entry;
};

export interface BuildConceptEdgesParams {
  workspaceId: string;
  uid?: string;
  docMetaIndex?: Map<string, DocMetaForGraph>;
}

interface ConceptCarrier {
  docId: string | null;
  conceptId: string;
  title: string;
}

const collectCarriers = (concepts: SemanticConceptRecord[], fragments: SemanticFragmentRecord[]): Map<string, ConceptCarrier[]> => {
  const byConcept = new Map<string, ConceptCarrier[]>();
  const addCarrier = (conceptId: string, title: string, docId: string | null) => {
    if (!docId) return;
    const list = byConcept.get(conceptId) ?? [];
    if (!list.some((c) => c.docId === docId)) {
      list.push({ docId, conceptId, title });
      byConcept.set(conceptId, list);
    }
  };
  for (const concept of concepts) {
    if (concept.docId) addCarrier(concept.id, concept.title, concept.docId);
  }
  for (const fragment of fragments) {
    if (!fragment.conceptId) continue;
    if (fragment.docId) addCarrier(fragment.conceptId, fragment.conceptTitle || '', fragment.docId);
  }
  return byConcept;
};

const resolveSemanticDocId = (workspaceId: string, uid?: string): string => (
  isPersonalWorkspaceId(workspaceId) && uid ? `${PERSONAL_WORKSPACE_ID}:${uid}` : workspaceId
);

export interface ConceptEdgePersistResult {
  pairsEvaluated: number;
  edgesWritten: number;
  docsTouched: number;
}

/**
 * Genera y persiste aristas de tipo `concept`: si un concepto está presente en
 * dos docs A y B, escribe una arista A→B y B→A con kind:'concept'.
 *
 * Este job recorre TODO el workspaceSemanticStates/{id} y agrupa carriers por
 * concept. Se usa desde el backfill admin endpoint. NO se invoca en
 * writeDocumentBlob (los conceptos no cambian al escribir contenido).
 */
export async function persistConceptEdgesForWorkspace(params: BuildConceptEdgesParams): Promise<ConceptEdgePersistResult> {
  const { workspaceId, uid } = params;
  const storageId = resolveSemanticDocId(workspaceId, uid);
  const semSnap = await adminDb.collection('workspaceSemanticStates').doc(storageId).get();
  if (!semSnap.exists) {
    return { pairsEvaluated: 0, edgesWritten: 0, docsTouched: 0 };
  }
  const state = normalizeSemanticWorkspaceState(semSnap.data());
  const carriersByConcept = collectCarriers(state.concepts, state.fragments);
  const meta = params.docMetaIndex ?? await loadWorkspaceDocMetaIndex(workspaceId, uid);
  const now = Date.now();

  const conceptEdgesByDoc = new Map<string, Map<string, CitationEdge>>();
  let pairsEvaluated = 0;
  for (const carriers of carriersByConcept.values()) {
    if (carriers.length < 2) continue;
    for (let i = 0; i < carriers.length; i += 1) {
      for (let j = 0; j < carriers.length; j += 1) {
        if (i === j) continue;
        const a = carriers[i]!;
        const b = carriers[j]!;
        if (!meta.has(a.docId!) || !meta.has(b.docId!)) continue;
        pairsEvaluated += 1;
        const docMap = conceptEdgesByDoc.get(a.docId!) ?? new Map<string, CitationEdge>();
        const key = `concept::${b.docId}`;
        const existing = docMap.get(key);
        if (existing) {
          existing.weight += 1;
        } else {
          docMap.set(key, {
            targetDocId: b.docId!,
            targetDocName: meta.get(b.docId!)?.name,
            kind: 'concept',
            weight: 1,
            resolvedAt: now
          });
        }
        conceptEdgesByDoc.set(a.docId!, docMap);
      }
    }
  }

  let edgesWritten = 0;
  let docsTouched = 0;
  for (const [docId, edgesMap] of conceptEdgesByDoc.entries()) {
    const conceptEdges = Array.from(edgesMap.values());
    const existing = await readCitationsExcludingConcept(docId);
    const merged = [...existing, ...conceptEdges];
    const result = await writeCitationsForDoc(docId, merged);
    edgesWritten += result.written;
    docsTouched += 1;
  }

  return { pairsEvaluated, edgesWritten, docsTouched };
}

/**
 * Lee citas existentes excluyendo las de kind:'concept' — necesario al
 * re-escribir concept edges en bulk para no duplicar wiki/link/bib.
 */
const readCitationsExcludingConcept = async (docId: string): Promise<CitationEdge[]> => {
  const snap = await adminDb.collection('documents').doc(docId).collection('citations').get();
  const edges: CitationEdge[] = [];
  for (const c of snap.docs) {
    const data = c.data() as Record<string, unknown>;
    if (data.kind === 'concept') continue;
    const kindRaw = data.kind;
    if (!isCitationKind(kindRaw) || kindRaw === 'concept') continue;
    const targetDocId = typeof data.targetDocId === 'string' ? data.targetDocId : '';
    if (!targetDocId) continue;
    const weight = typeof data.weight === 'number' && Number.isFinite(data.weight) ? data.weight : 1;
    const resolvedAt = typeof data.resolvedAt === 'number' && Number.isFinite(data.resolvedAt) ? data.resolvedAt : 0;
    const targetDocName = typeof data.targetDocName === 'string' ? data.targetDocName : undefined;
    const kind: CitationKind = kindRaw;
    edges.push({
      targetDocId,
      ...(targetDocName ? { targetDocName } : {}),
      kind,
      weight,
      resolvedAt
    });
  }
  return edges;
};

export interface ParseAndPersistCitationsParams {
  docId: string;
  workspaceId: string;
  uid?: string;
  content: string;
}

/**
 * Parsea wiki/link/bib del contenido y persiste, preservando las aristas
 * 'concept' ya existentes (si las hubiera) — para no destruir el grafo
 * generado por el job semántico cada vez que se edita un documento.
 */
export async function parseAndPersistCitationsForDoc(params: ParseAndPersistCitationsParams): Promise<{ written: number; deleted: number; total: number }> {
  const { docId, workspaceId, uid, content } = params;
  const index = await getWorkspaceCitationIndex(workspaceId, uid);
  const edges = parseCitations(content, index.docs, {
    selfDocId: docId,
    bibKeyIndex: index.bibIndex
  });
  const existing = await adminDb.collection('documents').doc(docId).collection('citations').get();
  const conceptEdges: CitationEdge[] = [];
  for (const c of existing.docs) {
    const data = c.data() as Record<string, unknown>;
    if (data.kind !== 'concept') continue;
    const targetDocId = typeof data.targetDocId === 'string' ? data.targetDocId : '';
    if (!targetDocId) continue;
    const weight = typeof data.weight === 'number' && Number.isFinite(data.weight) ? data.weight : 1;
    const resolvedAt = typeof data.resolvedAt === 'number' && Number.isFinite(data.resolvedAt) ? data.resolvedAt : 0;
    const targetDocName = typeof data.targetDocName === 'string' ? data.targetDocName : undefined;
    conceptEdges.push({
      targetDocId,
      ...(targetDocName ? { targetDocName } : {}),
      kind: 'concept',
      weight,
      resolvedAt
    });
  }
  const merged = [...edges, ...conceptEdges];
  const result = await writeCitationsForDoc(docId, merged);
  return { written: result.written, deleted: result.deleted, total: merged.length };
}

export interface BackfillWorkspaceCitationsResult {
  docsProcessed: number;
  edgesWritten: number;
  conceptEdges: ConceptEdgePersistResult;
  durationMs: number;
  errors: Array<{ docId: string; error: string }>;
}

export async function backfillWorkspaceCitations(workspaceId: string, uid?: string): Promise<BackfillWorkspaceCitationsResult> {
  const startedAt = Date.now();
  invalidateWorkspaceCitationIndex(workspaceId, uid);
  const index = await getWorkspaceCitationIndex(workspaceId, uid);

  const errors: Array<{ docId: string; error: string }> = [];
  let docsProcessed = 0;
  let edgesWritten = 0;

  const { getObjectBuffer } = await import('@/lib/nas-storage');

  for (const [docId, meta] of index.meta.entries()) {
    try {
      const docSnap = await adminDb.collection('documents').doc(docId).get();
      if (!docSnap.exists) continue;
      const data = docSnap.data() as Record<string, unknown>;
      const docType = typeof data.type === 'string' ? data.type : 'text';
      if (docType === 'folder') continue;
      const inlineContent = typeof data.content === 'string' ? data.content : '';
      const storagePath = typeof data.storagePath === 'string' ? data.storagePath : '';
      let content = inlineContent;
      if (storagePath) {
        try {
          const buf = await getObjectBuffer(storagePath);
          if (buf) content = buf.toString('utf8');
        } catch {
          // fallback to firestore content
        }
      }
      if (!content) continue;
      const edges = parseCitations(content, index.docs, {
        selfDocId: docId,
        bibKeyIndex: index.bibIndex
      });
      const result = await writeCitationsForDoc(docId, edges);
      edgesWritten += result.written;
      docsProcessed += 1;
      void meta;
    } catch (err) {
      errors.push({ docId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const conceptResult = await persistConceptEdgesForWorkspace({ workspaceId, uid, docMetaIndex: index.meta });
  edgesWritten += conceptResult.edgesWritten;

  return {
    docsProcessed,
    edgesWritten,
    conceptEdges: conceptResult,
    durationMs: Date.now() - startedAt,
    errors
  };
}
