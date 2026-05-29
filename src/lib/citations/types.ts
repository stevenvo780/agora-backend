export type CitationKind = 'wiki' | 'link' | 'concept' | 'bib';

export interface CitationPosition {
  line: number;
  col: number;
}

export interface CitationEdge {
  targetDocId: string;
  targetDocName?: string;
  kind: CitationKind;
  position?: CitationPosition;
  weight: number;
  resolvedAt: number;
}

export interface CitationGraphNode {
  docId: string;
  name: string;
  type: string;
  folder?: string | null;
  depth: number;
}

export interface CitationGraphEdge {
  from: string;
  to: string;
  kind: CitationKind;
  weight: number;
}

export interface CitationSubgraph {
  nodes: CitationGraphNode[];
  edges: CitationGraphEdge[];
  focus: string[];
  depth: number;
  truncated: boolean;
  /**
   * true cuando el grafo está incompleto por una falla recuperable (p.ej. la
   * query de aristas ENTRANTES falló por índice faltante). A diferencia de
   * `truncated` (recorte por caps), `partial` indica datos perdidos en
   * silencio que el consumidor debe poder señalar al usuario.
   */
  partial?: boolean;
}

export const CITATION_KINDS: ReadonlyArray<CitationKind> = ['wiki', 'link', 'concept', 'bib'];

export const isCitationKind = (value: unknown): value is CitationKind =>
  typeof value === 'string' && (CITATION_KINDS as ReadonlyArray<string>).includes(value);
