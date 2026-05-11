import type { DocumentTypeId } from '@/types/documents';

export enum SearchKind {
  Document = 'document',
  Concept = 'concept',
  Fragment = 'fragment',
  Author = 'author',
  Work = 'work'
}

export type SearchResultKind = `${SearchKind}`;
export const SEARCH_RESULT_KINDS = Object.values(SearchKind) as SearchResultKind[];
const SEARCH_RESULT_KIND_SET = new Set<SearchResultKind>(SEARCH_RESULT_KINDS);

export const ALL_SEARCH_RESULT_FILTER = 'all';

export type SearchResultFilter = typeof ALL_SEARCH_RESULT_FILTER | SearchResultKind;
export const isSearchResultKind = (value: string): value is SearchResultKind => SEARCH_RESULT_KIND_SET.has(value as SearchResultKind);

export interface SearchSourceDocument {
  id: string;
  name: string;
  type?: DocumentTypeId;
  folder?: string;
  workspaceId?: string;
  mimeType?: string;
  url?: string;
  storagePath?: string;
  ownerId?: string;
  updatedAt?: unknown;
  size?: number;
}

export interface SearchResultItem {
  id: string;
  kind: SearchResultKind;
  title: string;
  subtitle?: string;
  preview?: string;
  badge: string;
  score: number;
  matchedTerms: string[];
  sourceDoc: SearchSourceDocument;
}

export interface SemanticSearchRequest {
  query: string;
  workspaceId: string;
  limit?: number;
  offset?: number;
  kinds?: SearchResultKind[];
  pageSize?: number;
  cursor?: string | null;
}

export interface SemanticSearchResponse {
  results: SearchResultItem[];
  meta: {
    query: string;
    workspaceId: string;
    scannedDocuments: number;
    totalCandidates: number;
    offset: number;
    hasMore: boolean;
    mode: 'heuristic-v1';
  };
}

export const SEARCH_KIND_LABELS: Record<SearchResultKind, string> = {
  [SearchKind.Document]: 'Documento',
  [SearchKind.Concept]: 'Concepto',
  [SearchKind.Fragment]: 'Fragmento',
  [SearchKind.Author]: 'Autor',
  [SearchKind.Work]: 'Obra'
};

export const SEARCH_KIND_BADGES: Record<SearchResultKind, string> = {
  [SearchKind.Document]: 'DOC',
  [SearchKind.Concept]: 'CON',
  [SearchKind.Fragment]: 'FRG',
  [SearchKind.Author]: 'AUT',
  [SearchKind.Work]: 'OBR'
};
