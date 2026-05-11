/**
 * Helpers puros extraídos de toolExecutor.ts. Sin dependencias de
 * Firestore ni servicios — testeables en aislamiento.
 */
import { isPersonalWorkspaceId, PERSONAL_WORKSPACE_ID } from '@/types/workspace';

export const MAX_CONTENT_PREVIEW = 800;
export const DEFAULT_DOC_LIMIT = 100;
export const MAX_DOC_LIMIT = 500;

/**
 * Tamaño de página por defecto al iterar documentos del workspace.
 * NO es un cap. Es el `limit` que se aplica a cada query Firestore cuando el
 * caller no especifica uno. Si el workspace tiene más documentos, el caller
 * debe iterar usando `nextCursor` — la responsabilidad de decidir cuántas
 * páginas pedir vive en el caller (la tool o el agente IA), no aquí.
 */
export const DEFAULT_PAGE_SIZE = 2000;

/**
 * Límite técnico por página. Firestore tiende a tener latencias altas y
 * riesgo de timeout más allá de ~10k docs por query individual. Esto NO
 * limita el total accesible — solo el tamaño de cada página.
 */
export const MAX_PAGE_SIZE = 10_000;

export const DEFAULT_BOARD_COLUMNS = ['Por hacer', 'En progreso', 'Hecho'];

export interface PageMeta {
  hasMore: boolean;
  nextCursor: string | null;
  scannedThisPage: number;
}

export const buildPageMeta = (
  scannedThisPage: number,
  nextCursor: string | null
): PageMeta => ({
  hasMore: nextCursor !== null,
  nextCursor,
  scannedThisPage
});

export const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

export const resolvePageSize = (raw: unknown, defaultSize = DEFAULT_PAGE_SIZE) => {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return defaultSize;
  return clamp(Math.floor(raw), 1, MAX_PAGE_SIZE);
};

export const excerpt = (value: string, maxLength = MAX_CONTENT_PREVIEW) =>
  value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;

/**
 * Convierte `undefined` → `null` recursivamente. Firestore rechaza undefined
 * dentro de objetos pero acepta null. Sin esto, una doc con `field:undefined`
 * causaría INVALID_ARGUMENT al persistir.
 */
export const sanitizeFirestoreValue = (value: unknown): unknown => {
  if (value === undefined) return null;
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(item => sanitizeFirestoreValue(item));
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [key, sanitizeFirestoreValue(item)])
    );
  }
  return value;
};

/**
 * Para semantic state: workspace personal → `personal:<uid>` (un doc por
 * user); shared → directamente el `workspaceId` del repo.
 */
export const resolveSemanticDocId = (workspaceId: string, uid: string) =>
  isPersonalWorkspaceId(workspaceId) ? `${PERSONAL_WORKSPACE_ID}:${uid}` : workspaceId;

export const normalizeLookupKey = (value: string) => value.trim().toLowerCase();

export interface DocumentPageCursor {
  updatedAtMs: number;
  id: string;
}

export const encodeDocumentPageCursor = (cursor: DocumentPageCursor): string =>
  Buffer.from(JSON.stringify({ u: cursor.updatedAtMs, i: cursor.id }), 'utf8').toString('base64url');

export const decodeDocumentPageCursor = (raw: unknown): DocumentPageCursor | null => {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const buf = Buffer.from(raw, 'base64url');
    if (buf.byteLength === 0) return null;
    const parsed = JSON.parse(buf.toString('utf8')) as { u?: unknown; i?: unknown };
    if (typeof parsed.u !== 'number' || !Number.isFinite(parsed.u)) return null;
    if (typeof parsed.i !== 'string' || parsed.i.length === 0) return null;
    return { updatedAtMs: parsed.u, id: parsed.i };
  } catch {
    return null;
  }
};
