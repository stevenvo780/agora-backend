import { SEARCH_KIND_BADGES, SearchKind, type SearchResultItem, type SearchResultKind, type SearchSourceDocument } from '@/lib/search/types';

export interface SearchableDocument extends SearchSourceDocument {
  content?: string;
  createdAt?: unknown;
}

type SearchTerms = {
  query: string;
  normalizedQuery: string;
  primaryTokens: string[];
  expandedTokens: string[];
};

type FieldMatchConfig = {
  phraseWeight: number;
  tokenWeight: number;
  partialWeight: number;
  expansionWeight: number;
  coverageWeight: number;
};

type ExtractedSignals = {
  authors: string[];
  works: string[];
  concepts: string[];
  snippet: string;
};

const MAX_RESULTS_DEFAULT = 20;
const MIN_TOKEN_LENGTH = 2;
const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*/;
const HUMANITIES_SYNONYMS: Record<string, string[]> = {
  memoria: ['memorias', 'recuerdo', 'recuerdos', 'testimonio', 'testimonios'],
  archivo: ['archivos', 'fondo', 'fondos', 'documento', 'documentos'],
  colonial: ['colonia', 'coloniales', 'colonialidad'],
  autor: ['authors', 'author', 'autora', 'autores', 'escritor', 'escritora'],
  obra: ['obras', 'work', 'works', 'titulo', 'titulo', 'fuente', 'texto'],
  concepto: ['conceptos', 'tema', 'temas', 'idea', 'ideas', 'nocion', 'nociones'],
  testimonio: ['testimonios', 'relato', 'relatos', 'memoria']
};

const normalizeText = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s/_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tokenize = (value: string) =>
  normalizeText(value)
    .split(' ')
    .map(token => token.trim())
    .filter(token => token.length >= MIN_TOKEN_LENGTH);

const unique = <T,>(values: T[]) => Array.from(new Set(values));

const normalizeTokenVariant = (token: string) => {
  if (token.endsWith('es') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('s') && token.length > 3) return token.slice(0, -1);
  return token;
};

const expandTokens = (tokens: string[]) => {
  const variants = new Set<string>();

  tokens.forEach(token => {
    variants.add(token);
    variants.add(normalizeTokenVariant(token));
    const extra = HUMANITIES_SYNONYMS[token] ?? HUMANITIES_SYNONYMS[normalizeTokenVariant(token)] ?? [];
    extra.forEach(item => variants.add(normalizeTokenVariant(normalizeText(item))));
  });

  return Array.from(variants).filter(Boolean);
};

const makeSearchTerms = (query: string): SearchTerms => {
  const normalizedQuery = normalizeText(query);
  const primaryTokens = unique(tokenize(query));
  const expandedTokens = unique(expandTokens(primaryTokens));

  return {
    query: query.trim(),
    normalizedQuery,
    primaryTokens,
    expandedTokens
  };
};

const getTimestampValue = (value: unknown) => {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (typeof value === 'object' && value !== null) {
    const maybeSeconds = value as { seconds?: number; toMillis?: () => number };
    if (typeof maybeSeconds.toMillis === 'function') return maybeSeconds.toMillis();
    if (typeof maybeSeconds.seconds === 'number') return maybeSeconds.seconds * 1000;
  }
  return 0;
};

const scoreFieldMatch = (value: string, terms: SearchTerms, config: FieldMatchConfig) => {
  const normalized = normalizeText(value);
  if (!normalized) return { score: 0, matchedTerms: [] as string[] };
  if (!terms.normalizedQuery) return { score: 0, matchedTerms: [] as string[] };

  const words = new Set(tokenize(normalized));
  let score = normalized.includes(terms.normalizedQuery) ? config.phraseWeight : 0;
  const matchedTerms = new Set<string>();
  let coverage = 0;

  terms.primaryTokens.forEach(token => {
    if (words.has(token)) {
      score += config.tokenWeight;
      matchedTerms.add(token);
      coverage += 1;
      return;
    }
    if (normalized.includes(token)) {
      score += config.partialWeight;
      matchedTerms.add(token);
    }
  });

  terms.expandedTokens.forEach(token => {
    if (matchedTerms.has(token)) return;
    if (words.has(token) || normalized.includes(token)) {
      score += config.expansionWeight;
      matchedTerms.add(token);
    }
  });

  if (terms.primaryTokens.length > 0) {
    score += (coverage / terms.primaryTokens.length) * config.coverageWeight;
  }

  return { score, matchedTerms: Array.from(matchedTerms) };
};

const extractFrontmatter = (content: string) => {
  const match = content.match(FRONTMATTER_REGEX);
  return match?.[1] ?? '';
};

const parseListLikeValue = (value: string) =>
  value
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(/[;,]/)
    .map(item => item.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);

const extractFrontmatterList = (frontmatter: string, keys: string[]) => {
  if (!frontmatter) return [];
  const lines = frontmatter.split(/\r?\n/);
  const collected: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const key = normalizeText(line.slice(0, separator)).replace(/\s+/g, '');
    if (!keys.includes(key)) continue;

    const inlineValue = line.slice(separator + 1).trim();
    if (inlineValue) {
      collected.push(...parseListLikeValue(inlineValue));
      continue;
    }

    let cursor = index + 1;
    while (cursor < lines.length) {
      const nested = lines[cursor] ?? '';
      if (!/^\s+/.test(nested)) break;
      const itemMatch = nested.match(/^\s*-\s+(.+)$/);
      if (itemMatch?.[1]) {
        collected.push(itemMatch[1].trim().replace(/^["']|["']$/g, ''));
      }
      cursor += 1;
    }
  }

  return unique(collected.map(item => item.trim()).filter(Boolean));
};

const extractPatternValues = (content: string, keys: string[]) => {
  const collected: string[] = [];

  keys.forEach(key => {
    const pattern = new RegExp(`(?:^|\\n)\\s*${key}\\s*:\\s*(.+)`, 'gi');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const value = match[1]?.trim();
      if (!value) continue;
      collected.push(...parseListLikeValue(value));
    }
  });

  return unique(collected.map(item => item.trim()).filter(Boolean));
};

const extractMarkdownHeadings = (content: string) => {
  const headings = Array.from(content.matchAll(/^#{1,6}\s+(.+)$/gm))
    .map(match => match[1]?.trim())
    .filter((value): value is string => Boolean(value));

  return unique(headings);
};

const extractInlineTags = (content: string) =>
  unique(
    Array.from(content.matchAll(/(?:^|\s)#([A-Za-z0-9_-]+)/g))
      .map(match => match[1]?.trim())
      .filter((value): value is string => Boolean(value))
  );

const cleanSnippet = (value: string) =>
  value
    .replace(/\s+/g, ' ')
    .replace(/[#>*`_-]{2,}/g, ' ')
    .trim();

const extractSnippet = (content: string, terms: SearchTerms) => {
  const plain = cleanSnippet(content);
  if (!plain) return '';

  const lower = plain.toLowerCase();
  const candidates = [terms.query.toLowerCase(), ...terms.primaryTokens, ...terms.expandedTokens].filter(Boolean);
  const foundIndex = candidates.reduce<number>((best, token) => {
    if (best >= 0) return best;
    return lower.indexOf(token.toLowerCase());
  }, -1);

  if (foundIndex < 0) {
    return plain.slice(0, 180);
  }

  const start = Math.max(0, foundIndex - 80);
  const end = Math.min(plain.length, foundIndex + 140);
  const prefix = start > 0 ? '... ' : '';
  const suffix = end < plain.length ? ' ...' : '';
  return `${prefix}${plain.slice(start, end).trim()}${suffix}`;
};

const extractSignals = (doc: SearchableDocument, terms: SearchTerms): ExtractedSignals => {
  const content = typeof doc.content === 'string' ? doc.content : '';
  const frontmatter = extractFrontmatter(content);

  const authors = unique([
    ...extractFrontmatterList(frontmatter, ['author', 'authors', 'autor', 'autores']),
    ...extractPatternValues(content, ['author', 'authors', 'autor', 'autores'])
  ]);

  const works = unique([
    ...extractFrontmatterList(frontmatter, ['work', 'works', 'obra', 'obras', 'title', 'titulo', 'título', 'source', 'fuente']),
    ...extractPatternValues(content, ['work', 'works', 'obra', 'obras', 'title', 'titulo', 'título', 'source', 'fuente'])
  ]);

  const concepts = unique([
    ...extractFrontmatterList(frontmatter, ['tags', 'keywords', 'temas', 'tema', 'concepts', 'conceptos', 'topics']),
    ...extractMarkdownHeadings(content),
    ...extractInlineTags(content)
  ]).slice(0, 8);

  return {
    authors,
    works,
    concepts,
    snippet: extractSnippet(content, terms)
  };
};

const makeSourceDoc = (doc: SearchableDocument): SearchSourceDocument => ({
  id: doc.id,
  name: doc.name,
  type: doc.type,
  folder: doc.folder,
  workspaceId: doc.workspaceId,
  mimeType: doc.mimeType,
  url: doc.url,
  storagePath: doc.storagePath,
  ownerId: doc.ownerId,
  updatedAt: doc.updatedAt,
  size: doc.size
});

const buildDocumentResult = (doc: SearchableDocument, terms: SearchTerms): SearchResultItem | null => {
  if (!terms.normalizedQuery) {
    return {
      id: `document:${doc.id}`,
      kind: SearchKind.Document,
      title: doc.name,
      subtitle: doc.folder || 'Raiz del espacio',
      preview: doc.mimeType || 'Documento',
      badge: SEARCH_KIND_BADGES[SearchKind.Document],
      score: Math.max(1, getTimestampValue(doc.updatedAt) / 1_000_000_000_000),
      matchedTerms: [],
      sourceDoc: makeSourceDoc(doc)
    };
  }

  const nameMatch = scoreFieldMatch(doc.name, terms, {
    phraseWeight: 7,
    tokenWeight: 3.2,
    partialWeight: 1.8,
    expansionWeight: 0.7,
    coverageWeight: 2.4
  });
  const folderMatch = scoreFieldMatch(doc.folder ?? '', terms, {
    phraseWeight: 3,
    tokenWeight: 1.6,
    partialWeight: 0.9,
    expansionWeight: 0.4,
    coverageWeight: 1.2
  });
  const contentMatch = scoreFieldMatch(doc.content ?? '', terms, {
    phraseWeight: 4.2,
    tokenWeight: 1.7,
    partialWeight: 0.8,
    expansionWeight: 0.5,
    coverageWeight: 1.8
  });

  const score = nameMatch.score + folderMatch.score + contentMatch.score;
  if (score < 2.2) return null;

  return {
    id: `document:${doc.id}`,
    kind: SearchKind.Document,
    title: doc.name,
    subtitle: doc.folder || 'Raiz del espacio',
    preview: extractSnippet(doc.content ?? '', terms) || doc.mimeType || 'Documento',
    badge: SEARCH_KIND_BADGES[SearchKind.Document],
    score,
    matchedTerms: unique([...nameMatch.matchedTerms, ...folderMatch.matchedTerms, ...contentMatch.matchedTerms]),
    sourceDoc: makeSourceDoc(doc)
  };
};

const buildEntityResult = (
  kind: SearchKind.Concept | SearchKind.Author | SearchKind.Work,
  value: string,
  doc: SearchableDocument,
  terms: SearchTerms,
  subtitlePrefix: string
): SearchResultItem | null => {
  const match = scoreFieldMatch(value, terms, {
    phraseWeight: 6,
    tokenWeight: 2.8,
    partialWeight: 1.4,
    expansionWeight: 0.7,
    coverageWeight: 2.2
  });

  if (terms.normalizedQuery && match.score < 2.6) return null;
  if (!terms.normalizedQuery) return null;

  return {
    id: `${kind}:${doc.id}:${normalizeText(value).replace(/\s+/g, '-')}`,
    kind,
    title: value,
    subtitle: `${subtitlePrefix} ${doc.name}`,
    preview: extractSnippet(doc.content ?? '', terms),
    badge: SEARCH_KIND_BADGES[kind],
    score: match.score + 0.8,
    matchedTerms: match.matchedTerms,
    sourceDoc: makeSourceDoc(doc)
  };
};

const buildFragmentResult = (doc: SearchableDocument, terms: SearchTerms): SearchResultItem | null => {
  if (!terms.normalizedQuery || !doc.content) return null;
  const snippet = extractSnippet(doc.content, terms);
  if (!snippet) return null;

  const match = scoreFieldMatch(snippet, terms, {
    phraseWeight: 5,
    tokenWeight: 2.2,
    partialWeight: 1.2,
    expansionWeight: 0.6,
    coverageWeight: 2
  });

  if (match.score < 2.8) return null;

  return {
    id: `fragment:${doc.id}:${normalizeText(snippet).slice(0, 32).replace(/\s+/g, '-')}`,
    kind: SearchKind.Fragment,
    title: doc.name,
    subtitle: `Fragmento en ${doc.folder || 'raiz del espacio'}`,
    preview: snippet,
    badge: SEARCH_KIND_BADGES[SearchKind.Fragment],
    score: match.score + 0.4,
    matchedTerms: match.matchedTerms,
    sourceDoc: makeSourceDoc(doc)
  };
};

const kindOrder: Record<SearchResultKind, number> = {
  [SearchKind.Document]: 0,
  [SearchKind.Concept]: 1,
  [SearchKind.Fragment]: 2,
  [SearchKind.Author]: 3,
  [SearchKind.Work]: 4
};

export const buildSemanticSearchResults = (params: {
  docs: SearchableDocument[];
  query: string;
  limit?: number;
  offset?: number;
  kinds?: SearchResultKind[];
}) => {
  const terms = makeSearchTerms(params.query);
  const allowKinds = new Set(params.kinds?.length ? params.kinds : undefined);
  const rawResults: SearchResultItem[] = [];

  params.docs.forEach(doc => {
    const documentResult = buildDocumentResult(doc, terms);
    if (documentResult) {
      rawResults.push(documentResult);
    }

    if (!terms.normalizedQuery) return;

    const signals = extractSignals(doc, terms);

    signals.concepts.forEach(concept => {
      const result = buildEntityResult(SearchKind.Concept, concept, doc, terms, 'Concepto en');
      if (result) rawResults.push(result);
    });

    signals.authors.forEach(author => {
      const result = buildEntityResult(SearchKind.Author, author, doc, terms, 'Autor en');
      if (result) rawResults.push(result);
    });

    signals.works.forEach(work => {
      const result = buildEntityResult(SearchKind.Work, work, doc, terms, 'Obra en');
      if (result) rawResults.push(result);
    });

    const fragmentResult = buildFragmentResult(doc, terms);
    if (fragmentResult) {
      rawResults.push(fragmentResult);
    }
  });

  const filtered = rawResults.filter(result => {
    if (allowKinds.size === 0) return true;
    return allowKinds.has(result.kind);
  });

  filtered.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    const leftUpdated = getTimestampValue(left.sourceDoc.updatedAt);
    const rightUpdated = getTimestampValue(right.sourceDoc.updatedAt);
    if (rightUpdated !== leftUpdated) return rightUpdated - leftUpdated;
    if (kindOrder[left.kind] !== kindOrder[right.kind]) return kindOrder[left.kind] - kindOrder[right.kind];
    return left.title.localeCompare(right.title, 'es');
  });

  const limit = Math.max(1, Math.min(params.limit ?? MAX_RESULTS_DEFAULT, 50));
  const offset = Math.max(0, params.offset ?? 0);
  const deduped: SearchResultItem[] = [];
  const seen = new Set<string>();

  filtered.forEach(result => {
    const dedupeKey = `${result.kind}:${normalizeText(result.title)}:${result.sourceDoc.id}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    deduped.push(result);
  });

  const paged = deduped.slice(offset, offset + limit);

  return {
    results: paged,
    totalCandidates: deduped.length,
    offset,
    hasMore: offset + limit < deduped.length
  };
};
