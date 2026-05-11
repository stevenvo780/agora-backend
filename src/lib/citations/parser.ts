import type { CitationEdge, CitationKind, CitationPosition } from './types';

export interface WorkspaceDocRef {
  id: string;
  name?: string;
  folder?: string | null;
  storagePath?: string | null;
}

export interface ParseCitationsOptions {
  /** ID del documento que se está parseando — para no autocitarse. */
  selfDocId?: string;
  /** Tokens bibliográficos: clave (ej. "Searle2010") → docId. */
  bibKeyIndex?: Map<string, string>;
}

const normalizeKey = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

const KNOWN_EXTENSIONS = new Set(['md', 'markdown', 'st', 'txt', 'mdx', 'pdf', 'bib', 'docx', 'html', 'json']);

const stripExt = (value: string): string => {
  const m = value.match(/\.([A-Za-z0-9]{1,8})$/);
  if (!m) return value.trim();
  const ext = (m[1] ?? '').toLowerCase();
  if (!KNOWN_EXTENSIONS.has(ext)) return value.trim();
  return value.slice(0, -m[0].length).trim();
};

interface IndexEntry {
  id: string;
  name: string;
}

interface ResolverIndex {
  byNameNorm: Map<string, IndexEntry>;
  byPathNorm: Map<string, IndexEntry>;
  byBaseNameNorm: Map<string, IndexEntry>;
  byId: Map<string, IndexEntry>;
}

const buildResolverIndex = (docs: Map<string, WorkspaceDocRef>): ResolverIndex => {
  const byNameNorm = new Map<string, IndexEntry>();
  const byPathNorm = new Map<string, IndexEntry>();
  const byBaseNameNorm = new Map<string, IndexEntry>();
  const byId = new Map<string, IndexEntry>();
  for (const [id, doc] of docs.entries()) {
    const name = (doc.name || '').trim();
    if (!name && !doc.storagePath) continue;
    const entry: IndexEntry = { id, name: name || id };
    byId.set(id, entry);

    if (name) {
      const nameKey = normalizeKey(name);
      const baseKey = normalizeKey(stripExt(name));
      if (nameKey) {
        if (!byNameNorm.has(nameKey)) byNameNorm.set(nameKey, entry);
      }
      if (baseKey && baseKey !== nameKey) {
        if (!byBaseNameNorm.has(baseKey)) byBaseNameNorm.set(baseKey, entry);
      }
    }

    const folder = (doc.folder || '').trim();
    if (name && folder) {
      const pathKey = normalizeKey(`${folder.replace(/\/+$/, '')}/${name}`);
      if (pathKey && !byPathNorm.has(pathKey)) byPathNorm.set(pathKey, entry);
      const basePathKey = normalizeKey(`${folder.replace(/\/+$/, '')}/${stripExt(name)}`);
      if (basePathKey && !byPathNorm.has(basePathKey)) byPathNorm.set(basePathKey, entry);
    }

    if (doc.storagePath) {
      const sp = String(doc.storagePath);
      const last = sp.split('/').filter(Boolean).pop();
      if (last) {
        const k = normalizeKey(last);
        const bk = normalizeKey(stripExt(last));
        if (k && !byBaseNameNorm.has(k)) byBaseNameNorm.set(k, entry);
        if (bk && bk !== k && !byBaseNameNorm.has(bk)) byBaseNameNorm.set(bk, entry);
      }
    }
  }
  return { byNameNorm, byPathNorm, byBaseNameNorm, byId };
};

const resolveTarget = (raw: string, index: ResolverIndex): IndexEntry | null => {
  const cleaned = raw.trim();
  if (!cleaned) return null;
  if (index.byId.has(cleaned)) {
    return index.byId.get(cleaned) ?? null;
  }
  const norm = normalizeKey(cleaned);
  if (!norm) return null;
  if (index.byPathNorm.has(norm)) return index.byPathNorm.get(norm) ?? null;
  if (index.byNameNorm.has(norm)) return index.byNameNorm.get(norm) ?? null;
  const stripped = normalizeKey(stripExt(cleaned));
  if (stripped && index.byNameNorm.has(stripped)) return index.byNameNorm.get(stripped) ?? null;
  if (stripped && index.byBaseNameNorm.has(stripped)) return index.byBaseNameNorm.get(stripped) ?? null;
  if (index.byBaseNameNorm.has(norm)) return index.byBaseNameNorm.get(norm) ?? null;
  return null;
};

const isExternalUrl = (value: string): boolean =>
  /^(?:https?:|mailto:|tel:|ftp:|data:|javascript:|#)/i.test(value);

const computePosition = (content: string, offset: number): CitationPosition => {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return { line, col };
};

interface RawMatch {
  targetDocId: string;
  targetDocName: string;
  kind: CitationKind;
  position: CitationPosition;
}

const WIKI_REGEX = /\[\[([^\]\n]+?)\]\]/g;
const MARKDOWN_LINK_REGEX = /\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const BIB_REGEX = /\[@([A-Za-z0-9_.:-]+)(?:,\s*[^\]\n]*)?\]/g;

/**
 * Parsea citas explícitas e implícitas dentro del contenido markdown / mdx.
 * - wiki: `[[doc name]]`
 * - link: `[texto](otro.md)` apuntando a docs del workspace.
 * - bib: `[@Author2010]` resuelto contra `bibKeyIndex`.
 *
 * Las citas que apuntan a URL externas, anchors o protocolos especiales
 * se ignoran (no son citas inter-document).
 */
export function parseCitations(
  content: string,
  workspaceDocs: Map<string, WorkspaceDocRef>,
  options: ParseCitationsOptions = {}
): CitationEdge[] {
  if (typeof content !== 'string' || !content) return [];
  const index = buildResolverIndex(workspaceDocs);
  const matches: RawMatch[] = [];
  const selfId = options.selfDocId ?? null;
  const seenWiki = new Set<string>();
  WIKI_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKI_REGEX.exec(content)) !== null) {
    const raw = m[1];
    if (!raw) continue;
    const aliasSplit = raw.split('|');
    const target = aliasSplit[0]?.trim();
    if (!target) continue;
    const entry = resolveTarget(target, index);
    if (!entry) continue;
    if (selfId && entry.id === selfId) continue;
    matches.push({
      targetDocId: entry.id,
      targetDocName: entry.name,
      kind: 'wiki',
      position: computePosition(content, m.index)
    });
    seenWiki.add(`${m.index}:${target}`);
  }

  MARKDOWN_LINK_REGEX.lastIndex = 0;
  while ((m = MARKDOWN_LINK_REGEX.exec(content)) !== null) {
    const href = m[2];
    if (!href) continue;
    const trimmed = href.trim();
    if (!trimmed || isExternalUrl(trimmed)) continue;
    const stripped = trimmed.replace(/^\.\/+/, '').replace(/^\/+/, '');
    if (!stripped) continue;
    const entry = resolveTarget(stripped, index);
    if (!entry) continue;
    if (selfId && entry.id === selfId) continue;
    matches.push({
      targetDocId: entry.id,
      targetDocName: entry.name,
      kind: 'link',
      position: computePosition(content, m.index)
    });
  }

  const bibIndex = options.bibKeyIndex;
  if (bibIndex && bibIndex.size > 0) {
    BIB_REGEX.lastIndex = 0;
    while ((m = BIB_REGEX.exec(content)) !== null) {
      const key = m[1];
      if (!key) continue;
      const docId = bibIndex.get(key) || bibIndex.get(key.toLowerCase());
      if (!docId) continue;
      const entry = index.byId.get(docId);
      if (!entry) continue;
      if (selfId && entry.id === selfId) continue;
      matches.push({
        targetDocId: entry.id,
        targetDocName: entry.name,
        kind: 'bib',
        position: computePosition(content, m.index)
      });
    }
  }

  const now = Date.now();
  const grouped = new Map<string, CitationEdge>();
  for (const match of matches) {
    const key = `${match.kind}::${match.targetDocId}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.weight += 1;
      continue;
    }
    grouped.set(key, {
      targetDocId: match.targetDocId,
      targetDocName: match.targetDocName,
      kind: match.kind,
      position: match.position,
      weight: 1,
      resolvedAt: now
    });
  }
  return Array.from(grouped.values());
}

/**
 * Construye un índice de claves bibliográficas mirando el nombre del
 * documento y su storagePath: si el doc se llama "Searle2010.pdf" o
 * "searle-2010.bib" expone la clave normalizada → docId.
 *
 * No es un parser .bib completo (eso requiere bibtex-parse); cubre el caso
 * común de docs cuyo nombre coincide con la cite-key.
 */
export function buildBibKeyIndex(workspaceDocs: Iterable<WorkspaceDocRef>): Map<string, string> {
  const index = new Map<string, string>();
  for (const doc of workspaceDocs) {
    const candidates = new Set<string>();
    const name = (doc.name || '').trim();
    if (name) {
      const base = stripExt(name);
      candidates.add(base);
      candidates.add(base.replace(/\s+/g, ''));
    }
    if (doc.storagePath) {
      const sp = String(doc.storagePath);
      const last = sp.split('/').filter(Boolean).pop();
      if (last) {
        const base = stripExt(last);
        candidates.add(base);
        candidates.add(base.replace(/\s+/g, ''));
      }
    }
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (!index.has(candidate)) index.set(candidate, doc.id);
      const lower = candidate.toLowerCase();
      if (!index.has(lower)) index.set(lower, doc.id);
    }
  }
  return index;
}
