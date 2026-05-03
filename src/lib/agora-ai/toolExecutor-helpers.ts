/**
 * Helpers puros extraídos de toolExecutor.ts. Sin dependencias de
 * Firestore ni servicios — testeables en aislamiento.
 */
import { isPersonalWorkspaceId, PERSONAL_WORKSPACE_ID } from '@/types/workspace';

export const MAX_CONTENT_PREVIEW = 800;
export const DEFAULT_DOC_LIMIT = 25;
export const MAX_DOC_SCAN = 200;
export const DEFAULT_BOARD_COLUMNS = ['Por hacer', 'En progreso', 'Hecho'];

export const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

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
