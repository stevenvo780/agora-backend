/**
 * Contrato del payload publicado a RTDB `sync-events/<channel>`.
 * El cliente filtra por `orderByChild('timestamp')`, así que los pings
 * SIN `timestamp` quedan invisibles. Este parser garantiza el shape mínimo.
 *
 * Bugs cubiertos:
 *  - Payload con `ts` pero sin `timestamp` → invisible al cliente.
 *  - `source` ausente → cliente decide ignorarlo en algunas ramas.
 *  - Canal incorrecto: `sync-events/personal` (sin uid) → nadie escucha.
 */
import { err, fieldErr, isNumber, isObject, isString, ok, type ParseResult } from './result';
import { isPersonalWorkspaceId, PERSONAL_WORKSPACE_ID } from '@/types/workspace';

export interface SyncEventPayload {
  type: 'created' | 'updated' | 'deleted' | 'refresh';
  path: string;
  folder: string;
  docId: string | null;
  timestamp: number;
  source: 'worker' | 'frontend' | 'hub';
  scope: string;
  workspaceId: string | null;
  userId: string | null;
  version: number | null;
  contentHash: string | null;
  sender: string;
  ts: number;
}

const VALID_TYPES = new Set(['created', 'updated', 'deleted', 'refresh']);
const VALID_SOURCES = new Set(['worker', 'frontend', 'hub']);

export const parseSyncEventPayload = (input: unknown): ParseResult<SyncEventPayload> => {
  if (!isObject(input)) return err('payload must be a JSON object');
  if (!isString(input.type) || !VALID_TYPES.has(input.type)) {
    return fieldErr('type', "'created'|'updated'|'deleted'|'refresh'", input.type);
  }
  if (!isNumber(input.timestamp)) return fieldErr('timestamp', 'number (ms)', input.timestamp);
  if (!isString(input.source) || !VALID_SOURCES.has(input.source)) {
    return fieldErr('source', "'worker'|'frontend'|'hub'", input.source);
  }
  return ok({
    type: input.type as SyncEventPayload['type'],
    path: isString(input.path) ? input.path : '',
    folder: isString(input.folder) ? input.folder : 'No estructurado',
    docId: isString(input.docId) ? input.docId : null,
    timestamp: input.timestamp,
    source: input.source as SyncEventPayload['source'],
    scope: isString(input.scope) ? input.scope : 'document',
    workspaceId: isString(input.workspaceId) ? input.workspaceId : null,
    userId: isString(input.userId) ? input.userId : null,
    version: isNumber(input.version) ? input.version : null,
    contentHash: isString(input.contentHash) ? input.contentHash : null,
    sender: isString(input.sender) ? input.sender : 'hub',
    ts: isNumber(input.ts) ? input.ts : input.timestamp
  });
};

/**
 * Resuelve el canal RTDB. Personal workspace SIEMPRE usa
 * `sync-events/personal_<uid>`. Aceptamos `__personal__`, `personal:<uid>`
 * y workspaceId nulo+userId presente. Si no se puede resolver un uid para
 * un workspace personal → falla, el caller decide qué hacer.
 */
export interface ResolveChannelInput {
  workspaceId: string | null | undefined;
  userId: string | null | undefined;
}

export const resolveSyncChannel = (input: ResolveChannelInput): ParseResult<string> => {
  const ws = input.workspaceId ?? null;
  if (ws && isPersonalWorkspaceId(ws)) {
    const uid = ws === PERSONAL_WORKSPACE_ID ? input.userId : ws.replace(/^personal:/, '');
    if (!uid) return err('personal workspace requires userId to resolve channel');
    return ok(`sync-events/personal_${uid}`);
  }
  if (ws) return ok(`sync-events/${ws}`);
  if (input.userId) return ok(`sync-events/personal_${input.userId}`);
  return ok('sync-events/global');
};
