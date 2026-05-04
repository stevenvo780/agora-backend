import {
  EMPTY_SEMANTIC_WORKSPACE_STATE,
  normalizeSemanticWorkspaceState,
  type SemanticConceptRecord,
  type SemanticRelationRecord,
  type SemanticRelationType,
  type SemanticWorkspaceState
} from '@/lib/semantic/workspace-state';
import {
  type AgentToolCall, type AgentExecutionContext, type AgentToolExecutionResult,
  ok, clamp,
  ensureWorkspaceAccess,
  adminDb, FieldValue, resolveSemanticDocId, normalizeLookupKey
} from './shared';

type ToolHandler = (call: AgentToolCall, ctx: AgentExecutionContext) => Promise<AgentToolExecutionResult>;

// loadSemanticState and saveSemanticState are in shared.ts but semantic-specific
// We re-import from shared where needed, and define semantic-only helpers here

async function loadSemanticState(ctx: AgentExecutionContext): Promise<SemanticWorkspaceState> {
  await ensureWorkspaceAccess(ctx.workspaceId, ctx.uid);
  const storageId = resolveSemanticDocId(ctx.workspaceId, ctx.uid);
  const snap = await adminDb.collection('workspaceSemanticStates').doc(storageId).get();
  if (!snap.exists) return EMPTY_SEMANTIC_WORKSPACE_STATE;
  return normalizeSemanticWorkspaceState(snap.data());
}

async function saveSemanticState(ctx: AgentExecutionContext, state: SemanticWorkspaceState) {
  const storageId = resolveSemanticDocId(ctx.workspaceId, ctx.uid);
  const normalized = normalizeSemanticWorkspaceState({
    ...state,
    updatedAt: Date.now()
  });
  const clean = JSON.parse(JSON.stringify({
    workspaceId: ctx.workspaceId,
    storageId,
    concepts: normalized.concepts,
    fragments: normalized.fragments,
    relations: normalized.relations,
    updatedAt: normalized.updatedAt,
    updatedBy: ctx.uid
  }));
  clean.serverUpdatedAt = FieldValue.serverTimestamp();
  await adminDb.collection('workspaceSemanticStates').doc(storageId).set(clean, { merge: true });
  return normalized;
}

function resolveConcept(state: SemanticWorkspaceState, rawId: string): SemanticConceptRecord {
  const direct = state.concepts.find((concept) => concept.id === rawId);
  if (direct) return direct;
  const key = normalizeLookupKey(rawId);
  const exact = state.concepts.filter((concept) => normalizeLookupKey(concept.title) === key);
  if (exact.length === 1) { const match = exact[0]; if (match) return match; }
  if (exact.length > 1) throw new Error(`Múltiples conceptos coinciden con "${rawId}".`);
  const partial = state.concepts.filter((concept) => normalizeLookupKey(concept.title).includes(key));
  if (partial.length === 1) { const match = partial[0]; if (match) return match; }
  if (partial.length > 1) throw new Error(`Múltiples conceptos coinciden parcialmente con "${rawId}".`);
  throw new Error(`Concepto no encontrado: "${rawId}".`);
}

async function getSemanticState(call: AgentToolCall, ctx: AgentExecutionContext) {
  await ensureWorkspaceAccess(ctx.workspaceId, ctx.uid);
  const storageId = resolveSemanticDocId(ctx.workspaceId, ctx.uid);
  const snap = await adminDb.collection('workspaceSemanticStates').doc(storageId).get();
  const state = snap.exists ? snap.data() as Record<string, unknown> : { concepts: [], fragments: [], relations: [] };
  return ok(call, 'Recuperé el estado semántico.', {
    state: {
      concepts: Array.isArray(state.concepts) ? state.concepts : [],
      fragments: Array.isArray(state.fragments) ? state.fragments : [],
      relations: Array.isArray(state.relations) ? state.relations : [],
      updatedAt: state.updatedAt ?? null
    }
  });
}

async function listConcepts(call: AgentToolCall, ctx: AgentExecutionContext) {
  const state = await loadSemanticState(ctx);
  const queryText = typeof call.args.query === 'string' ? call.args.query.trim().toLowerCase() : '';
  const limit = clamp(typeof call.args.limit === 'number' ? call.args.limit : 25, 1, 50);
  const concepts = state.concepts
    .filter((concept) => !queryText || [concept.title, concept.definition, concept.formula, concept.logicProfile]
      .map((value) => String(value || '').toLowerCase())
      .join('\n')
      .includes(queryText))
    .slice(0, limit)
    .map((concept) => ({
      id: concept.id,
      title: concept.title,
      definition: concept.definition || '',
      formula: concept.formula || '',
      logicProfile: concept.logicProfile || null,
      status: concept.status || 'draft',
      updatedAt: concept.updatedAt
    }));
  return ok(call, `Encontré ${concepts.length} concepto(s).`, { concepts });
}

async function defineConcept(call: AgentToolCall, ctx: AgentExecutionContext) {
  const title = String(call.args.title || '').trim();
  if (!title) throw new Error('title es requerido');
  const state = await loadSemanticState(ctx);
  const existing = state.concepts.find((concept) => normalizeLookupKey(concept.title) === normalizeLookupKey(title));
  const now = Date.now();
  const excerpt = typeof call.args.excerpt === 'string' && call.args.excerpt.trim()
    ? call.args.excerpt.trim()
    : (typeof call.args.definition === 'string' ? call.args.definition.trim() : title);
  const fragmentId = existing?.sourceFragmentId || `semantic-fragment-${now}-${Math.random().toString(36).slice(2, 7)}`;
  const docId = typeof call.args.docId === 'string' ? call.args.docId : null;
  const docName = typeof call.args.docName === 'string' && call.args.docName.trim() ? call.args.docName.trim() : 'Agora AI';

  if (!state.fragments.some((fragment) => fragment.id === fragmentId)) {
    state.fragments.unshift({
      id: fragmentId,
      kind: 'concept',
      entityKind: typeof call.args.formula === 'string' ? 'claim' : typeof call.args.definition === 'string' ? 'definition' : 'concept',
      text: excerpt,
      excerpt: excerpt.slice(0, 160),
      docId,
      docName,
      workspaceId: ctx.workspaceId,
      createdAt: now,
      updatedAt: now,
      selectionHash: `${title}:${now}`,
      origin: 'llm',
      scope: 'workspace',
      status: typeof call.args.definition === 'string' ? 'validated' : 'draft',
      sourceRefs: [{ docId, docName, excerpt: excerpt.slice(0, 160) }]
    });
  }

  if (existing) {
    existing.title = title;
    if (typeof call.args.definition === 'string') existing.definition = call.args.definition.trim();
    if (typeof call.args.formula === 'string') existing.formula = call.args.formula.trim();
    if (typeof call.args.logicProfile === 'string') existing.logicProfile = call.args.logicProfile.trim();
    existing.updatedAt = now;
    existing.origin = 'llm';
    existing.scope = 'workspace';
    existing.status = typeof call.args.definition === 'string' ? 'validated' : existing.status;
    existing.docId = docId;
    existing.docName = docName;
  } else {
    state.concepts.unshift({
      id: `semantic-concept-${now}-${Math.random().toString(36).slice(2, 7)}`,
      title,
      entityKind: typeof call.args.formula === 'string' ? 'claim' : typeof call.args.definition === 'string' ? 'definition' : 'concept',
      definition: typeof call.args.definition === 'string' ? call.args.definition.trim() : undefined,
      formula: typeof call.args.formula === 'string' ? call.args.formula.trim() : undefined,
      logicProfile: typeof call.args.logicProfile === 'string' ? call.args.logicProfile.trim() : undefined,
      excerpt: excerpt.slice(0, 160),
      docId,
      docName,
      workspaceId: ctx.workspaceId,
      createdAt: now,
      updatedAt: now,
      sourceFragmentId: fragmentId,
      origin: 'llm',
      scope: 'workspace',
      status: typeof call.args.definition === 'string' ? 'validated' : 'draft',
      sourceRefs: [{ docId, docName, excerpt: excerpt.slice(0, 160) }]
    });
  }

  const saved = await saveSemanticState(ctx, state);
  const concept = saved.concepts.find((item) => normalizeLookupKey(item.title) === normalizeLookupKey(title));
  return ok(call, `Registré el concepto "${title}" en el glosario semántico.`, {
    concept: concept || null
  });
}

async function createRelation(call: AgentToolCall, ctx: AgentExecutionContext) {
  const sourceConceptId = String(call.args.sourceConceptId || '').trim();
  const targetConceptId = String(call.args.targetConceptId || '').trim();
  const relationType = (typeof call.args.relationType === 'string' ? call.args.relationType : 'supports') as SemanticRelationType;
  if (!sourceConceptId || !targetConceptId) throw new Error('sourceConceptId y targetConceptId son requeridos');
  const state = await loadSemanticState(ctx);
  const source = resolveConcept(state, sourceConceptId);
  const target = resolveConcept(state, targetConceptId);
  const now = Date.now();
  const fragmentId = `semantic-relation-fragment-${now}-${Math.random().toString(36).slice(2, 7)}`;
  state.fragments.unshift({
    id: fragmentId,
    kind: 'relation',
    entityKind: 'passage',
    text: `${source.title} ${relationType} ${target.title}`,
    excerpt: `${source.title} ${relationType} ${target.title}`,
    docId: source.docId || target.docId || null,
    docName: source.docName || target.docName || 'Agora AI',
    workspaceId: ctx.workspaceId,
    createdAt: now,
    updatedAt: now,
    selectionHash: `${source.id}:${target.id}:${relationType}`,
    conceptId: target.id,
    conceptTitle: target.title,
    origin: 'llm',
    scope: 'workspace',
    status: 'draft',
    sourceRefs: [{ docId: source.docId || null, docName: source.docName || null, excerpt: `${source.title} → ${target.title}` }]
  });
  const relation: SemanticRelationRecord = {
    id: `semantic-relation-${now}-${Math.random().toString(36).slice(2, 7)}`,
    fragmentId,
    conceptId: target.id,
    conceptTitle: target.title,
    relationType,
    createdAt: now,
    updatedAt: now,
    docId: source.docId || target.docId || null,
    origin: 'llm',
    scope: 'workspace',
    logicProfile: source.logicProfile || target.logicProfile || undefined,
    status: 'draft',
    sourceEntityId: source.id,
    targetEntityId: target.id,
    selectionHash: `${source.id}:${target.id}:${relationType}`,
    sourceRefs: [{ docId: source.docId || null, docName: source.docName || null, excerpt: `${source.title} → ${target.title}` }]
  };
  state.relations.unshift(relation);
  await saveSemanticState(ctx, state);
  return ok(call, `Registré la relación ${relationType} entre "${source.title}" y "${target.title}".`, { relation });
}

async function listGlossaryEntries(call: AgentToolCall, ctx: AgentExecutionContext) {
  return listConcepts({ ...call, name: 'list_concepts' }, ctx);
}

async function searchGlossaryEntries(call: AgentToolCall, ctx: AgentExecutionContext) {
  return listConcepts({ ...call, name: 'list_concepts' }, ctx);
}

export const SEMANTIC_TOOL_HANDLERS: Record<string, ToolHandler> = {
  get_semantic_state: getSemanticState,
  list_concepts: listConcepts,
  define_concept: defineConcept,
  create_relation: createRelation,
  list_glossary_entries: listGlossaryEntries,
  search_glossary_entries: searchGlossaryEntries
};
