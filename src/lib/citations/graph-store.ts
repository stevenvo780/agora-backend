import { adminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { isPersonalWorkspaceId, PERSONAL_WORKSPACE_ID } from '@/types/workspace';
import {
  type CitationEdge,
  type CitationGraphEdge,
  type CitationGraphNode,
  type CitationKind,
  type CitationSubgraph,
  CITATION_KINDS,
  isCitationKind
} from './types';

const CITATIONS_SUBCOLLECTION = 'citations';
const MAX_NODES_HARD_CAP = 500;
const MAX_EDGES_HARD_CAP = 2000;

const stripUndefined = <T extends Record<string, unknown>>(value: T): T => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
};

const edgeDocId = (edge: CitationEdge): string => `${edge.kind}__${edge.targetDocId}`;

export async function writeCitationsForDoc(docId: string, edges: CitationEdge[]): Promise<{ written: number; deleted: number }> {
  if (!docId) return { written: 0, deleted: 0 };
  const docRef = adminDb.collection('documents').doc(docId);
  const subRef = docRef.collection(CITATIONS_SUBCOLLECTION);

  const existingSnap = await subRef.get();
  const existingIds = new Set<string>(existingSnap.docs.map((d) => d.id));

  const writeBatch = adminDb.batch();
  const incomingIds = new Set<string>();
  for (const edge of edges) {
    const id = edgeDocId(edge);
    if (incomingIds.has(id)) continue;
    incomingIds.add(id);
    const ref = subRef.doc(id);
    writeBatch.set(ref, stripUndefined({
      targetDocId: edge.targetDocId,
      targetDocName: edge.targetDocName ?? null,
      kind: edge.kind,
      position: edge.position ? { line: edge.position.line, col: edge.position.col } : null,
      weight: edge.weight,
      resolvedAt: edge.resolvedAt,
      updatedAt: FieldValue.serverTimestamp()
    }));
  }

  const toDelete: string[] = [];
  for (const id of existingIds) {
    if (!incomingIds.has(id)) toDelete.push(id);
  }
  for (const id of toDelete) {
    writeBatch.delete(subRef.doc(id));
  }

  if (incomingIds.size === 0 && toDelete.length === 0) {
    return { written: 0, deleted: 0 };
  }

  await writeBatch.commit();
  return { written: incomingIds.size, deleted: toDelete.length };
}

export async function readCitationsFromDoc(docId: string): Promise<CitationEdge[]> {
  if (!docId) return [];
  const snap = await adminDb.collection('documents').doc(docId).collection(CITATIONS_SUBCOLLECTION).get();
  const edges: CitationEdge[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown>;
    const kindRaw = data.kind;
    if (!isCitationKind(kindRaw)) continue;
    const targetDocId = typeof data.targetDocId === 'string' ? data.targetDocId : '';
    if (!targetDocId) continue;
    const weight = typeof data.weight === 'number' && Number.isFinite(data.weight) ? data.weight : 1;
    const resolvedAt = typeof data.resolvedAt === 'number' && Number.isFinite(data.resolvedAt) ? data.resolvedAt : 0;
    const pos = data.position as { line?: unknown; col?: unknown } | null | undefined;
    const position = pos && typeof pos.line === 'number' && typeof pos.col === 'number'
      ? { line: pos.line, col: pos.col }
      : undefined;
    const targetDocName = typeof data.targetDocName === 'string' ? data.targetDocName : undefined;
    edges.push({
      targetDocId,
      ...(targetDocName ? { targetDocName } : {}),
      kind: kindRaw,
      ...(position ? { position } : {}),
      weight,
      resolvedAt
    });
  }
  return edges;
}

export interface DocMetaForGraph {
  docId: string;
  name: string;
  type: string;
  folder?: string | null;
}

const buildWorkspaceDocsQuery = (workspaceId: string, uid?: string) => {
  if (isPersonalWorkspaceId(workspaceId)) {
    if (!uid) {
      return adminDb.collection('documents').where('workspaceId', '==', PERSONAL_WORKSPACE_ID);
    }
    return adminDb.collection('documents')
      .where('ownerId', '==', uid)
      .where('workspaceId', '==', PERSONAL_WORKSPACE_ID);
  }
  return adminDb.collection('documents').where('workspaceId', '==', workspaceId);
};

export async function loadWorkspaceDocMetaIndex(workspaceId: string, uid?: string): Promise<Map<string, DocMetaForGraph>> {
  const snap = await buildWorkspaceDocsQuery(workspaceId, uid).get();
  const map = new Map<string, DocMetaForGraph>();
  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown>;
    map.set(doc.id, {
      docId: doc.id,
      name: typeof data.name === 'string' ? data.name : 'Sin título',
      type: typeof data.type === 'string' ? data.type : 'text',
      folder: typeof data.folder === 'string' ? data.folder : null
    });
  }
  return map;
}

export interface ExpandSubgraphOptions {
  workspaceId: string;
  focusDocIds: string[];
  depth: number;
  kinds?: CitationKind[];
  uid?: string;
  maxNodes?: number;
  docMetaIndex?: Map<string, DocMetaForGraph>;
}

/**
 * BFS sobre las subcolecciones `documents/{id}/citations`. Trata las aristas
 * como no dirigidas para el propósito de navegar contexto: tanto las citas
 * salientes del nodo focal como las entrantes (otros docs que lo citan).
 *
 * Para las entrantes hacemos una query collectionGroup filtrada por
 * `targetDocId`, restringida al workspace mediante el meta-index.
 *
 * Caso especial workspace-wide: cuando `focusDocIds.length > maxNodes / 2`
 * (e.g. el route handler manda todos los docs del workspace), el BFS por
 * niveles ya no aporta: cualquier doc que cita o es citado ya está en el
 * foco. En ese modo escaneamos las edges con una sola query collectionGroup
 * filtrada por `workspaceId`, restringimos contra `metaIndex` y aplicamos
 * los caps al final. Eso evita el bug en el que el cap de nodos cortaba el
 * BFS antes de leer ninguna cita.
 */
export async function expandSubgraph(options: ExpandSubgraphOptions): Promise<CitationSubgraph> {
  const { workspaceId, depth } = options;
  const focusDocIds = Array.from(new Set(options.focusDocIds.filter((id) => typeof id === 'string' && id.length > 0)));
  if (focusDocIds.length === 0) {
    return { nodes: [], edges: [], focus: [], depth: 0, truncated: false };
  }
  const kindsFilter = options.kinds && options.kinds.length > 0 ? new Set<CitationKind>(options.kinds) : null;
  const maxNodes = Math.min(MAX_NODES_HARD_CAP, Math.max(1, options.maxNodes ?? MAX_NODES_HARD_CAP));
  const normalizedDepth = Math.max(0, Math.min(5, Math.floor(depth)));

  const metaIndex = options.docMetaIndex ?? await loadWorkspaceDocMetaIndex(workspaceId, options.uid);

  const focusSet = new Set<string>(focusDocIds);
  const isWorkspaceWide = shouldUseWorkspaceWideScan(focusDocIds.length, maxNodes);

  if (isWorkspaceWide) {
    return scanWorkspaceWideSubgraph({
      workspaceId,
      focusDocIds,
      metaIndex,
      kindsFilter,
      maxNodes,
      normalizedDepth
    });
  }

  const nodesById = new Map<string, CitationGraphNode>();
  const visited = new Set<string>();
  const edgesOut: CitationGraphEdge[] = [];
  const edgeSeen = new Set<string>();
  let truncated = false;

  const ensureNode = (docId: string, distance: number, force: boolean): void => {
    if (nodesById.has(docId)) {
      const node = nodesById.get(docId);
      if (node && distance < node.depth) node.depth = distance;
      return;
    }
    if (!force && nodesById.size >= maxNodes) {
      truncated = true;
      return;
    }
    const meta = metaIndex.get(docId);
    if (!meta) {
      nodesById.set(docId, {
        docId,
        name: docId,
        type: 'text',
        folder: null,
        depth: distance
      });
      return;
    }
    nodesById.set(docId, {
      docId,
      name: meta.name,
      type: meta.type,
      folder: meta.folder ?? null,
      depth: distance
    });
  };

  for (const id of focusDocIds) ensureNode(id, 0, true);

  let frontier: string[] = focusDocIds.slice();
  for (let level = 0; level <= normalizedDepth; level += 1) {
    if (frontier.length === 0) break;
    const nextFrontier: string[] = [];
    const canExpand = level < normalizedDepth;

    for (const docId of frontier) {
      if (visited.has(docId)) continue;
      visited.add(docId);

      const outgoing = await readCitationsFromDoc(docId);
      for (const edge of outgoing) {
        if (kindsFilter && !kindsFilter.has(edge.kind)) continue;
        const targetId = edge.targetDocId;
        const targetKnown = metaIndex.has(targetId) || nodesById.has(targetId);
        if (!targetKnown) continue;
        const targetIsFocal = focusSet.has(targetId);
        const canAddTargetNode = nodesById.has(targetId) || targetIsFocal || (canExpand && nodesById.size < maxNodes);
        if (!canAddTargetNode) {
          truncated = true;
          continue;
        }
        const key = `${docId}->${targetId}:${edge.kind}`;
        if (edgeSeen.has(key)) continue;
        if (edgesOut.length >= MAX_EDGES_HARD_CAP) { truncated = true; continue; }
        edgeSeen.add(key);
        edgesOut.push({ from: docId, to: targetId, kind: edge.kind, weight: edge.weight });
        ensureNode(targetId, level + 1, targetIsFocal);
        if (canExpand && !visited.has(targetId)) nextFrontier.push(targetId);
      }

      try {
        const incomingSnap = await adminDb.collectionGroup(CITATIONS_SUBCOLLECTION)
          .where('targetDocId', '==', docId)
          .limit(200)
          .get();
        for (const cit of incomingSnap.docs) {
          const data = cit.data() as Record<string, unknown>;
          const kindRaw = data.kind;
          if (!isCitationKind(kindRaw)) continue;
          if (kindsFilter && !kindsFilter.has(kindRaw)) continue;
          const parentRef = cit.ref.parent.parent;
          if (!parentRef) continue;
          const sourceId = parentRef.id;
          if (sourceId === docId) continue;
          if (!metaIndex.has(sourceId)) continue;
          const sourceIsFocal = focusSet.has(sourceId);
          const canAddSourceNode = nodesById.has(sourceId) || sourceIsFocal || (canExpand && nodesById.size < maxNodes);
          if (!canAddSourceNode) {
            truncated = true;
            continue;
          }
          const key = `${sourceId}->${docId}:${kindRaw}`;
          if (edgeSeen.has(key)) continue;
          if (edgesOut.length >= MAX_EDGES_HARD_CAP) { truncated = true; continue; }
          edgeSeen.add(key);
          const weight = typeof data.weight === 'number' && Number.isFinite(data.weight) ? data.weight : 1;
          edgesOut.push({ from: sourceId, to: docId, kind: kindRaw, weight });
          ensureNode(sourceId, level + 1, sourceIsFocal);
          if (canExpand && !visited.has(sourceId)) nextFrontier.push(sourceId);
        }
      } catch (err) {
        console.warn('[expandSubgraph] collectionGroup incoming query failed:', err instanceof Error ? err.message : err);
      }
    }

    frontier = canExpand ? nextFrontier : [];
  }

  return {
    nodes: Array.from(nodesById.values()),
    edges: edgesOut,
    focus: focusDocIds,
    depth: normalizedDepth,
    truncated
  };
}

interface ScanWorkspaceWideOptions {
  workspaceId: string;
  focusDocIds: string[];
  metaIndex: Map<string, DocMetaForGraph>;
  kindsFilter: Set<CitationKind> | null;
  maxNodes: number;
  normalizedDepth: number;
}

/**
 * Modo workspace-wide: una sola query collectionGroup paginada para barrer
 * todas las citas del workspace y reconstruir el grafo en memoria. Mantiene
 * los caps duros pero recortando por *menos conectados primero* (degree).
 */
async function scanWorkspaceWideSubgraph(opts: ScanWorkspaceWideOptions): Promise<CitationSubgraph> {
  const { focusDocIds, metaIndex, kindsFilter, maxNodes, normalizedDepth } = opts;
  const focusSet = new Set<string>(focusDocIds);

  type RawEdge = { from: string; to: string; kind: CitationKind; weight: number };
  const rawEdges: RawEdge[] = [];
  let truncated = false;

  const PAGE_SIZE = 500;
  let lastDocRef: FirebaseFirestore.DocumentSnapshot | null = null;
  let safety = 0;

  while (safety < 200) {
    safety += 1;
    let q = adminDb.collectionGroup(CITATIONS_SUBCOLLECTION).limit(PAGE_SIZE);
    if (lastDocRef) q = q.startAfter(lastDocRef);
    let snap: FirebaseFirestore.QuerySnapshot;
    try {
      snap = await q.get();
    } catch (err) {
      console.warn('[scanWorkspaceWideSubgraph] collectionGroup scan failed:', err instanceof Error ? err.message : err);
      break;
    }
    if (snap.empty) break;
    for (const cit of snap.docs) {
      const parentRef = cit.ref.parent.parent;
      if (!parentRef) continue;
      const sourceId = parentRef.id;
      if (!focusSet.has(sourceId) && !metaIndex.has(sourceId)) continue;
      const data = cit.data() as Record<string, unknown>;
      const kindRaw = data.kind;
      if (!isCitationKind(kindRaw)) continue;
      if (kindsFilter && !kindsFilter.has(kindRaw)) continue;
      const targetDocId = typeof data.targetDocId === 'string' ? data.targetDocId : '';
      if (!targetDocId || targetDocId === sourceId) continue;
      if (!focusSet.has(targetDocId) && !metaIndex.has(targetDocId)) continue;
      const weight = typeof data.weight === 'number' && Number.isFinite(data.weight) ? data.weight : 1;
      rawEdges.push({ from: sourceId, to: targetDocId, kind: kindRaw, weight });
    }
    const lastSnap = snap.docs[snap.docs.length - 1];
    if (!lastSnap || snap.size < PAGE_SIZE) break;
    lastDocRef = lastSnap;
  }

  const degree = new Map<string, number>();
  const bumpDegree = (id: string) => degree.set(id, (degree.get(id) ?? 0) + 1);
  const dedupKey = new Set<string>();
  const uniqueEdges: RawEdge[] = [];
  for (const e of rawEdges) {
    const k = `${e.from}->${e.to}:${e.kind}`;
    if (dedupKey.has(k)) continue;
    dedupKey.add(k);
    uniqueEdges.push(e);
    bumpDegree(e.from);
    bumpDegree(e.to);
  }

  const nodeIds = new Set<string>(focusDocIds);
  for (const e of uniqueEdges) {
    nodeIds.add(e.from);
    nodeIds.add(e.to);
  }

  let finalNodeIds: Set<string>;
  if (nodeIds.size <= maxNodes) {
    finalNodeIds = nodeIds;
  } else {
    truncated = true;
    const sorted = rankNodesForCap(Array.from(nodeIds), focusSet, degree);
    finalNodeIds = new Set<string>(sorted.slice(0, maxNodes));
  }

  const filteredEdges: CitationGraphEdge[] = [];
  for (const e of uniqueEdges) {
    if (!finalNodeIds.has(e.from) || !finalNodeIds.has(e.to)) continue;
    if (filteredEdges.length >= MAX_EDGES_HARD_CAP) { truncated = true; break; }
    filteredEdges.push({ from: e.from, to: e.to, kind: e.kind, weight: e.weight });
  }

  const nodes: CitationGraphNode[] = [];
  for (const id of finalNodeIds) {
    const meta = metaIndex.get(id);
    nodes.push(meta ? {
      docId: id,
      name: meta.name,
      type: meta.type,
      folder: meta.folder ?? null,
      depth: focusSet.has(id) ? 0 : 1
    } : {
      docId: id,
      name: id,
      type: 'text',
      folder: null,
      depth: focusSet.has(id) ? 0 : 1
    });
  }

  return {
    nodes,
    edges: filteredEdges,
    focus: focusDocIds,
    depth: normalizedDepth,
    truncated
  };
}

export const CITATION_GRAPH_HARD_CAPS = {
  maxNodes: MAX_NODES_HARD_CAP,
  maxEdges: MAX_EDGES_HARD_CAP,
  maxDepth: 5
} as const;

/**
 * Helper puro extraído para test. Decide si una corrida de `expandSubgraph`
 * usa la ruta workspace-wide (single collectionGroup scan) vs BFS por nivel.
 * Bug fix: cuando el caller pasa todos los docs del workspace como foco y
 * supera `maxNodes/2`, el BFS antes cortaba sin leer citas y devolvía
 * `edges=0`. Ahora ese caso usa el scan.
 */
export const shouldUseWorkspaceWideScan = (focusCount: number, maxNodes: number): boolean =>
  focusCount > Math.max(1, Math.floor(maxNodes / 2));

/**
 * Helper puro: ranking de nodos para podar workspace-wide cuando excede el
 * cap. Focos primero, luego mayor grado.
 */
export const rankNodesForCap = (
  nodeIds: ReadonlyArray<string>,
  focusSet: ReadonlySet<string>,
  degree: ReadonlyMap<string, number>
): string[] =>
  Array.from(nodeIds).sort((a, b) => {
    const aFocal = focusSet.has(a) ? 1 : 0;
    const bFocal = focusSet.has(b) ? 1 : 0;
    if (aFocal !== bFocal) return bFocal - aFocal;
    const aDeg = degree.get(a) ?? 0;
    const bDeg = degree.get(b) ?? 0;
    return bDeg - aDeg;
  });

export { CITATION_KINDS };
