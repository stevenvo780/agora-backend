export type SemanticFragmentKind =
  | 'concept'
  | 'evidence'
  | 'pinned'
  | 'relation'
  | 'semantic-block'
  | 'note'
  | 'passage'
  | 'source';

export type SemanticEntityKind =
  | 'concept'
  | 'claim'
  | 'evidence'
  | 'definition'
  | 'source'
  | 'passage';

export type SemanticNodeOrigin = 'semantic-ui' | 'st-source' | 'autologic' | 'llm' | 'system';
export type SemanticScope = 'document' | 'workspace' | 'theory-file';
export type SemanticStatus = 'draft' | 'validated' | 'contradicted' | 'unsupported';
export type WorkspaceExperienceMode = 'assisted' | 'hybrid' | 'expert';

export type SemanticRelationType =
  | 'supports'
  | 'contradicts'
  | 'implies'
  | 'depends-on'
  | 'defines'
  | 'example-of'
  | 'evidence-for'
  | 'evidence-against'
  | 'restates'
  | 'questions'
  | 'related-to';

export interface SemanticSourceRef {
  docId?: string | null;
  docName?: string | null;
  fileName?: string | null;
  line?: number | null;
  column?: number | null;
  excerpt?: string;
  nodeId?: string;
}

export interface SemanticTraceEntry {
  origin: SemanticNodeOrigin;
  engine?: string;
  note?: string;
  updatedAt?: number;
  userEdited?: boolean;
}

export interface SemanticWorkspacePreferences {
  experienceMode: WorkspaceExperienceMode;
  showSTPreview: boolean;
  showPedagogicalHints: boolean;
}

interface SemanticRecordBase {
  origin?: SemanticNodeOrigin;
  scope?: SemanticScope;
  logicProfile?: string;
  confidence?: number;
  status?: SemanticStatus;
  sourceRefs?: SemanticSourceRef[];
  trace?: SemanticTraceEntry[];
  stableKey?: string;
  metadata?: Record<string, unknown>;
}

export interface SemanticFragmentRecord extends SemanticRecordBase {
  id: string;
  kind: SemanticFragmentKind;
  entityKind?: SemanticEntityKind;
  text: string;
  excerpt: string;
  note?: string;
  docId: string | null;
  docName: string;
  workspaceId: string;
  createdAt: number;
  updatedAt: number;
  selectionHash: string;
  docBlockId?: string;
  conceptId?: string;
  conceptTitle?: string;
  linkedDocId?: string;
  linkedDocName?: string;
}

export interface SemanticConceptRecord extends SemanticRecordBase {
  id: string;
  title: string;
  entityKind?: SemanticEntityKind;
  definition?: string;
  logicProfile?: string;
  formula?: string;
  excerpt: string;
  docId: string | null;
  docName: string;
  workspaceId: string;
  createdAt: number;
  updatedAt: number;
  sourceFragmentId: string;
  canonicalId?: string;
}

export interface SemanticRelationRecord extends SemanticRecordBase {
  id: string;
  fragmentId: string;
  conceptId: string;
  conceptTitle: string;
  relationType: SemanticRelationType;
  createdAt: number;
  updatedAt?: number;
  selectionHash?: string;
  docId?: string | null;
  sourceEntityId?: string;
  targetEntityId?: string;
}

export interface SemanticWorkspaceState {
  concepts: SemanticConceptRecord[];
  fragments: SemanticFragmentRecord[];
  relations: SemanticRelationRecord[];
  updatedAt: number;
  preferences: SemanticWorkspacePreferences;
}

export interface SemanticDocumentRef {
  docId?: string | null;
  docName?: string | null;
}

const DEFAULT_PREFERENCES: SemanticWorkspacePreferences = {
  experienceMode: 'hybrid',
  showSTPreview: true,
  showPedagogicalHints: true
};

export const EMPTY_SEMANTIC_WORKSPACE_STATE: SemanticWorkspaceState = {
  concepts: [],
  fragments: [],
  relations: [],
  updatedAt: 0,
  preferences: DEFAULT_PREFERENCES
};

const FRAGMENT_KIND_SET = new Set<SemanticFragmentKind>([
  'concept',
  'evidence',
  'pinned',
  'relation',
  'semantic-block',
  'note',
  'passage',
  'source'
]);

const ENTITY_KIND_SET = new Set<SemanticEntityKind>([
  'concept',
  'claim',
  'evidence',
  'definition',
  'source',
  'passage'
]);

const RELATION_TYPE_SET = new Set<SemanticRelationType>([
  'supports',
  'contradicts',
  'implies',
  'depends-on',
  'defines',
  'example-of',
  'evidence-for',
  'evidence-against',
  'restates',
  'questions',
  'related-to'
]);

const ORIGIN_SET = new Set<SemanticNodeOrigin>(['semantic-ui', 'st-source', 'autologic', 'llm', 'system']);
const SCOPE_SET = new Set<SemanticScope>(['document', 'workspace', 'theory-file']);
const STATUS_SET = new Set<SemanticStatus>(['draft', 'validated', 'contradicted', 'unsupported']);
const EXPERIENCE_MODE_SET = new Set<WorkspaceExperienceMode>(['assisted', 'hybrid', 'expert']);

const toNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const toBoolean = (value: unknown, fallback: boolean) => {
  if (typeof value === 'boolean') return value;
  return fallback;
};

const sortByUpdatedAt = <T extends { updatedAt?: number; createdAt?: number }>(items: T[]) => (
  items.slice().sort((left, right) => {
    const leftUpdated = left.updatedAt ?? left.createdAt ?? 0;
    const rightUpdated = right.updatedAt ?? right.createdAt ?? 0;
    if (rightUpdated !== leftUpdated) return rightUpdated - leftUpdated;
    return 0;
  })
);

const normalizeEntityKind = (value: unknown, fallback: SemanticEntityKind): SemanticEntityKind => (
  typeof value === 'string' && ENTITY_KIND_SET.has(value as SemanticEntityKind)
    ? value as SemanticEntityKind
    : fallback
);

const normalizeOrigin = (value: unknown, fallback: SemanticNodeOrigin): SemanticNodeOrigin => (
  typeof value === 'string' && ORIGIN_SET.has(value as SemanticNodeOrigin)
    ? value as SemanticNodeOrigin
    : fallback
);

const normalizeScope = (value: unknown, fallback: SemanticScope): SemanticScope => (
  typeof value === 'string' && SCOPE_SET.has(value as SemanticScope)
    ? value as SemanticScope
    : fallback
);

const normalizeStatus = (value: unknown, fallback: SemanticStatus): SemanticStatus => (
  typeof value === 'string' && STATUS_SET.has(value as SemanticStatus)
    ? value as SemanticStatus
    : fallback
);

const normalizeSourceRefs = (value: unknown): SemanticSourceRef[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as Partial<SemanticSourceRef>;
      return {
        ...(typeof raw.docId === 'string' || raw.docId === null ? { docId: raw.docId ?? null } : {}),
        ...(typeof raw.docName === 'string' || raw.docName === null ? { docName: raw.docName ?? null } : {}),
        ...(typeof raw.fileName === 'string' || raw.fileName === null ? { fileName: raw.fileName ?? null } : {}),
        ...(typeof raw.line === 'number' || typeof raw.line === 'string' ? { line: toNumber(raw.line) } : {}),
        ...(typeof raw.column === 'number' || typeof raw.column === 'string' ? { column: toNumber(raw.column) } : {}),
        ...(typeof raw.excerpt === 'string' ? { excerpt: raw.excerpt } : {}),
        ...(typeof raw.nodeId === 'string' ? { nodeId: raw.nodeId } : {})
      };
    })
    .filter((item) => item !== null) as SemanticSourceRef[];
};

const normalizeTrace = (value: unknown): SemanticTraceEntry[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as Partial<SemanticTraceEntry>;
      const origin = normalizeOrigin(raw.origin, 'system');
      return {
        origin,
        ...(typeof raw.engine === 'string' ? { engine: raw.engine } : {}),
        ...(typeof raw.note === 'string' ? { note: raw.note } : {}),
        ...(typeof raw.updatedAt === 'number' || typeof raw.updatedAt === 'string' ? { updatedAt: toNumber(raw.updatedAt) } : {}),
        ...(typeof raw.userEdited === 'boolean' ? { userEdited: raw.userEdited } : {})
      };
    })
    .filter((item): item is SemanticTraceEntry => item !== null);
};

const normalizeMetadata = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
};

const normalizeConfidence = (value: unknown): number | undefined => {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const confidence = toNumber(value);
  if (!Number.isFinite(confidence)) return undefined;
  return Math.max(0, Math.min(1, confidence));
};

const normalizePreferences = (value: unknown): SemanticWorkspacePreferences => {
  if (!value || typeof value !== 'object') return DEFAULT_PREFERENCES;
  const raw = value as Partial<SemanticWorkspacePreferences>;
  return {
    experienceMode: typeof raw.experienceMode === 'string' && EXPERIENCE_MODE_SET.has(raw.experienceMode as WorkspaceExperienceMode)
      ? raw.experienceMode as WorkspaceExperienceMode
      : DEFAULT_PREFERENCES.experienceMode,
    showSTPreview: toBoolean(raw.showSTPreview, DEFAULT_PREFERENCES.showSTPreview),
    showPedagogicalHints: toBoolean(raw.showPedagogicalHints, DEFAULT_PREFERENCES.showPedagogicalHints)
  };
};

const normalizeConcept = (value: unknown): SemanticConceptRecord | null => {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<SemanticConceptRecord>;
  if (typeof raw.id !== 'string' || typeof raw.title !== 'string') return null;
  return {
    id: raw.id,
    title: raw.title,
    entityKind: normalizeEntityKind(raw.entityKind, raw.formula ? 'claim' : raw.definition ? 'definition' : 'concept'),
    ...(typeof raw.definition === 'string' && raw.definition ? { definition: raw.definition } : {}),
    ...(typeof raw.logicProfile === 'string' && raw.logicProfile ? { logicProfile: raw.logicProfile } : {}),
    ...(typeof raw.formula === 'string' && raw.formula ? { formula: raw.formula } : {}),
    excerpt: typeof raw.excerpt === 'string' ? raw.excerpt : '',
    docId: typeof raw.docId === 'string' ? raw.docId : null,
    docName: typeof raw.docName === 'string' ? raw.docName : 'Documento',
    workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : '',
    createdAt: toNumber(raw.createdAt),
    updatedAt: toNumber(raw.updatedAt),
    sourceFragmentId: typeof raw.sourceFragmentId === 'string' ? raw.sourceFragmentId : '',
    origin: normalizeOrigin(raw.origin, 'semantic-ui'),
    scope: normalizeScope(raw.scope, 'document'),
    ...(normalizeConfidence(raw.confidence) !== undefined ? { confidence: normalizeConfidence(raw.confidence) } : {}),
    status: normalizeStatus(raw.status, raw.formula ? 'draft' : 'validated'),
    ...(normalizeSourceRefs(raw.sourceRefs).length > 0 ? { sourceRefs: normalizeSourceRefs(raw.sourceRefs) } : {}),
    ...(normalizeTrace(raw.trace).length > 0 ? { trace: normalizeTrace(raw.trace) } : {}),
    ...(typeof raw.stableKey === 'string' ? { stableKey: raw.stableKey } : {}),
    ...(typeof raw.canonicalId === 'string' ? { canonicalId: raw.canonicalId } : {}),
    ...(normalizeMetadata(raw.metadata) ? { metadata: normalizeMetadata(raw.metadata) } : {})
  };
};

const normalizeFragment = (value: unknown): SemanticFragmentRecord | null => {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<SemanticFragmentRecord>;
  if (typeof raw.id !== 'string' || typeof raw.kind !== 'string' || typeof raw.selectionHash !== 'string') return null;
  if (!FRAGMENT_KIND_SET.has(raw.kind as SemanticFragmentKind)) return null;
  const normalizedNote = typeof raw.note === 'string' ? raw.note.trim() : '';
  return {
    id: raw.id,
    kind: raw.kind as SemanticFragmentKind,
    entityKind: normalizeEntityKind(raw.entityKind, raw.kind === 'evidence' ? 'evidence' : raw.kind === 'source' ? 'source' : raw.kind === 'passage' ? 'passage' : 'concept'),
    text: typeof raw.text === 'string' ? raw.text : '',
    excerpt: typeof raw.excerpt === 'string' ? raw.excerpt : '',
    ...(normalizedNote ? { note: normalizedNote } : {}),
    docId: typeof raw.docId === 'string' ? raw.docId : null,
    docName: typeof raw.docName === 'string' ? raw.docName : 'Documento',
    workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : '',
    createdAt: toNumber(raw.createdAt),
    updatedAt: toNumber(raw.updatedAt),
    selectionHash: raw.selectionHash,
    ...(typeof raw.docBlockId === 'string' ? { docBlockId: raw.docBlockId } : {}),
    ...(typeof raw.conceptId === 'string' ? { conceptId: raw.conceptId } : {}),
    ...(typeof raw.conceptTitle === 'string' ? { conceptTitle: raw.conceptTitle } : {}),
    ...(typeof raw.linkedDocId === 'string' ? { linkedDocId: raw.linkedDocId } : {}),
    ...(typeof raw.linkedDocName === 'string' ? { linkedDocName: raw.linkedDocName } : {}),
    origin: normalizeOrigin(raw.origin, 'semantic-ui'),
    scope: normalizeScope(raw.scope, 'document'),
    ...(typeof raw.logicProfile === 'string' && raw.logicProfile ? { logicProfile: raw.logicProfile } : {}),
    ...(normalizeConfidence(raw.confidence) !== undefined ? { confidence: normalizeConfidence(raw.confidence) } : {}),
    status: normalizeStatus(raw.status, raw.kind === 'evidence' ? 'validated' : 'draft'),
    ...(normalizeSourceRefs(raw.sourceRefs).length > 0 ? { sourceRefs: normalizeSourceRefs(raw.sourceRefs) } : {}),
    ...(normalizeTrace(raw.trace).length > 0 ? { trace: normalizeTrace(raw.trace) } : {}),
    ...(typeof raw.stableKey === 'string' ? { stableKey: raw.stableKey } : {}),
    ...(normalizeMetadata(raw.metadata) ? { metadata: normalizeMetadata(raw.metadata) } : {})
  };
};

const normalizeRelationType = (value: unknown): SemanticRelationType => {
  if (value === 'related-to') return 'supports';
  if (typeof value === 'string' && RELATION_TYPE_SET.has(value as SemanticRelationType)) {
    return value as SemanticRelationType;
  }
  return 'supports';
};

const normalizeRelation = (value: unknown): SemanticRelationRecord | null => {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<SemanticRelationRecord>;
  if (typeof raw.id !== 'string' || typeof raw.conceptId !== 'string' || typeof raw.fragmentId !== 'string') return null;
  return {
    id: raw.id,
    fragmentId: raw.fragmentId,
    conceptId: raw.conceptId,
    conceptTitle: typeof raw.conceptTitle === 'string' ? raw.conceptTitle : '',
    relationType: normalizeRelationType(raw.relationType),
    createdAt: toNumber(raw.createdAt),
    ...(typeof raw.updatedAt === 'number' || typeof raw.updatedAt === 'string' ? { updatedAt: toNumber(raw.updatedAt) } : {}),
    selectionHash: typeof raw.selectionHash === 'string' ? raw.selectionHash : undefined,
    docId: typeof raw.docId === 'string' ? raw.docId : null,
    origin: normalizeOrigin(raw.origin, 'semantic-ui'),
    scope: normalizeScope(raw.scope, 'document'),
    ...(typeof raw.logicProfile === 'string' && raw.logicProfile ? { logicProfile: raw.logicProfile } : {}),
    ...(normalizeConfidence(raw.confidence) !== undefined ? { confidence: normalizeConfidence(raw.confidence) } : {}),
    status: normalizeStatus(raw.status, 'draft'),
    ...(normalizeSourceRefs(raw.sourceRefs).length > 0 ? { sourceRefs: normalizeSourceRefs(raw.sourceRefs) } : {}),
    ...(normalizeTrace(raw.trace).length > 0 ? { trace: normalizeTrace(raw.trace) } : {}),
    ...(typeof raw.stableKey === 'string' ? { stableKey: raw.stableKey } : {}),
    ...(typeof raw.sourceEntityId === 'string' ? { sourceEntityId: raw.sourceEntityId } : {}),
    ...(typeof raw.targetEntityId === 'string' ? { targetEntityId: raw.targetEntityId } : {}),
    ...(normalizeMetadata(raw.metadata) ? { metadata: normalizeMetadata(raw.metadata) } : {})
  };
};

export const normalizeSemanticWorkspaceState = (value: unknown): SemanticWorkspaceState => {
  if (!value || typeof value !== 'object') return EMPTY_SEMANTIC_WORKSPACE_STATE;
  const raw = value as Partial<SemanticWorkspaceState>;
  const concepts = Array.isArray(raw.concepts)
    ? raw.concepts.map(normalizeConcept).filter((item): item is SemanticConceptRecord => item !== null)
    : [];
  const fragments = Array.isArray(raw.fragments)
    ? raw.fragments.map(normalizeFragment).filter((item): item is SemanticFragmentRecord => item !== null)
    : [];
  const relations = Array.isArray(raw.relations)
    ? raw.relations.map(normalizeRelation).filter((item): item is SemanticRelationRecord => item !== null)
    : [];

  return {
    concepts: sortByUpdatedAt(concepts),
    fragments: sortByUpdatedAt(fragments),
    relations: relations
      .slice()
      .sort((left, right) => {
        const rightUpdated = right.updatedAt ?? right.createdAt;
        const leftUpdated = left.updatedAt ?? left.createdAt;
        if (rightUpdated !== leftUpdated) return rightUpdated - leftUpdated;
        return 0;
      }),
    updatedAt: toNumber(raw.updatedAt),
    preferences: normalizePreferences(raw.preferences)
  };
};

const pickNewer = <T extends { updatedAt?: number; createdAt?: number }>(left: T, right: T) => {
  const leftUpdated = left.updatedAt ?? left.createdAt ?? 0;
  const rightUpdated = right.updatedAt ?? right.createdAt ?? 0;
  return rightUpdated >= leftUpdated ? { ...left, ...right } : { ...right, ...left };
};

const normalizeTitleKey = (value: string) => (
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
);

const matchesSemanticDocument = (
  target: SemanticDocumentRef,
  item: { docId?: string | null; docName?: string | null }
) => {
  if (target.docId && item.docId && target.docId === item.docId) {
    return true;
  }

  if (target.docName && item.docName) {
    return normalizeTitleKey(target.docName) === normalizeTitleKey(item.docName);
  }

  return false;
};

const getConceptKey = (concept: SemanticConceptRecord) => (
  concept.stableKey || concept.id || `title:${normalizeTitleKey(concept.title)}:${concept.docId || concept.docName || ''}`
);

const getFragmentKey = (fragment: SemanticFragmentRecord) => {
  if (fragment.stableKey) return fragment.stableKey;
  const conceptKey = fragment.conceptId || '-';
  const linkedDocKey = fragment.linkedDocId || '-';
  const blockKey = fragment.docBlockId || '-';
  return `${fragment.kind}:${fragment.docId || 'sin-doc'}:${fragment.selectionHash}:${conceptKey}:${linkedDocKey}:${blockKey}`;
};

const getRelationKey = (relation: SemanticRelationRecord) => {
  if (relation.stableKey) return relation.stableKey;
  const semanticKey = relation.selectionHash
    ? `${relation.docId || 'sin-doc'}:${relation.selectionHash}:${relation.conceptId}:${relation.relationType}`
    : relation.id;
  return semanticKey;
};

const pickPreferences = (...preferences: SemanticWorkspacePreferences[]) => (
  preferences.reduce<SemanticWorkspacePreferences>((current, next) => ({
    experienceMode: next.experienceMode || current.experienceMode,
    showSTPreview: next.showSTPreview,
    showPedagogicalHints: next.showPedagogicalHints
  }), DEFAULT_PREFERENCES)
);

export const mergeSemanticWorkspaceStates = (...states: SemanticWorkspaceState[]): SemanticWorkspaceState => {
  const concepts = new Map<string, SemanticConceptRecord>();
  const fragments = new Map<string, SemanticFragmentRecord>();
  const relations = new Map<string, SemanticRelationRecord>();
  let updatedAt = 0;
  const preferences: SemanticWorkspacePreferences[] = [];

  states.forEach((state) => {
    const normalized = normalizeSemanticWorkspaceState(state);
    updatedAt = Math.max(updatedAt, normalized.updatedAt);
    preferences.push(normalized.preferences);

    normalized.concepts.forEach((concept) => {
      const key = getConceptKey(concept);
      const existing = concepts.get(key);
      concepts.set(key, existing ? pickNewer(existing, concept) : concept);
    });

    normalized.fragments.forEach((fragment) => {
      const key = getFragmentKey(fragment);
      const existing = fragments.get(key);
      fragments.set(key, existing ? pickNewer(existing, fragment) : fragment);
    });

    normalized.relations.forEach((relation) => {
      const key = getRelationKey(relation);
      const existing = relations.get(key);
      if (!existing) {
        relations.set(key, relation);
        return;
      }
      relations.set(key, pickNewer(existing, relation));
    });
  });

  return {
    concepts: sortByUpdatedAt(Array.from(concepts.values())),
    fragments: sortByUpdatedAt(Array.from(fragments.values())),
    relations: Array.from(relations.values()).sort((left, right) => {
      const rightUpdated = right.updatedAt ?? right.createdAt;
      const leftUpdated = left.updatedAt ?? left.createdAt;
      return rightUpdated - leftUpdated;
    }),
    updatedAt,
    preferences: pickPreferences(...preferences)
  };
};

export const filterSemanticWorkspaceStateByDocument = (
  state: SemanticWorkspaceState,
  target: SemanticDocumentRef
): SemanticWorkspaceState => {
  const normalized = normalizeSemanticWorkspaceState(state);

  if (!target.docId && !target.docName) {
    return normalized;
  }

  const concepts = normalized.concepts.filter((concept) => matchesSemanticDocument(target, concept));
  const conceptIds = new Set(concepts.map((concept) => concept.id));

  const fragments = normalized.fragments.filter((fragment) => (
    matchesSemanticDocument(target, fragment)
    || (fragment.conceptId ? conceptIds.has(fragment.conceptId) : false)
  ));
  const fragmentIds = new Set(fragments.map((fragment) => fragment.id));

  const relations = normalized.relations.filter((relation) => (
    conceptIds.has(relation.conceptId)
    || fragmentIds.has(relation.fragmentId)
    || (target.docId ? relation.docId === target.docId : false)
  ));

  return {
    concepts,
    fragments,
    relations,
    updatedAt: normalized.updatedAt,
    preferences: normalized.preferences
  };
};

export const removeSemanticWorkspaceSlice = (
  state: SemanticWorkspaceState,
  matcher: (record: SemanticConceptRecord | SemanticFragmentRecord | SemanticRelationRecord) => boolean
): SemanticWorkspaceState => {
  const normalized = normalizeSemanticWorkspaceState(state);
  return {
    concepts: normalized.concepts.filter((concept) => !matcher(concept)),
    fragments: normalized.fragments.filter((fragment) => !matcher(fragment)),
    relations: normalized.relations.filter((relation) => !matcher(relation)),
    updatedAt: normalized.updatedAt,
    preferences: normalized.preferences
  };
};

export const hasSemanticWorkspaceStateChanged = (left: SemanticWorkspaceState, right: SemanticWorkspaceState) => {
  return JSON.stringify(normalizeSemanticWorkspaceState(left)) !== JSON.stringify(normalizeSemanticWorkspaceState(right));
};

export const getRecentSemanticItems = (state: SemanticWorkspaceState) => {
  const normalized = normalizeSemanticWorkspaceState(state);
  return {
    concepts: normalized.concepts.slice(0, 5),
    notes: normalized.fragments.filter((item) => item.kind === 'note').slice(0, 5),
    pinned: normalized.fragments.filter((item) => item.kind === 'pinned').slice(0, 5),
    evidence: normalized.fragments.filter((item) => item.kind === 'evidence').slice(0, 5),
    relations: normalized.relations.slice(0, 5)
  };
};
