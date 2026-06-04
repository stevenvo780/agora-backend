/**
 * Persistencia Firestore de las conversaciones del agente IA.
 *
 * Schema:
 *   users/{uid}/agentChats/{chatId}                 — metadata
 *   users/{uid}/agentChats/{chatId}/messages/{msgId} — contenido
 *
 * El stream del agente llama `appendChatMessage` por cada mensaje user y
 * cada mensaje assistant final (incluyendo toolCalls y toolResults). El
 * cliente sólo lee a través de los endpoints REST.
 */
import { z } from 'zod';
import { adminDb } from '@/lib/firebase-admin';
import { FieldValue, type Timestamp } from 'firebase-admin/firestore';
import { ok, err, parseZod, type ParseResult } from '@agora/contracts';

const PROVIDER_VALUES = ['openai', 'anthropic', 'gemini', 'google', 'deepseek', 'ollama', 'agora-gateway', 'custom'] as const;

export const chatCreateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  provider: z.enum(PROVIDER_VALUES).optional(),
  workspaceContext: z.string().trim().max(120).optional()
});
export type ChatCreatePayload = z.infer<typeof chatCreateSchema>;
export const parseChatCreatePayload = (input: unknown): ParseResult<ChatCreatePayload> =>
  parseZod(chatCreateSchema, input);

export const chatPatchSchema = z.object({
  title: z.string().trim().min(1).max(200)
});
export type ChatPatchPayload = z.infer<typeof chatPatchSchema>;
export const parseChatPatchPayload = (input: unknown): ParseResult<ChatPatchPayload> =>
  parseZod(chatPatchSchema, input);

export const chatMessageAppendSchema = z.object({
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string().max(200_000),
  toolCalls: z.array(z.unknown()).optional(),
  toolResults: z.array(z.unknown()).optional(),
  citations: z.array(z.unknown()).optional()
});
export type ChatMessageAppendPayload = z.infer<typeof chatMessageAppendSchema>;
export const parseChatMessageAppendPayload = (input: unknown): ParseResult<ChatMessageAppendPayload> =>
  parseZod(chatMessageAppendSchema, input);

export interface AgentChatRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  provider: typeof PROVIDER_VALUES[number] | null;
  workspaceContext: string | null;
  totalTokens: number;
}

export type AgentMessageStatus = 'running' | 'complete' | 'truncated' | 'error';

export interface AgentChatMessageRecord {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  ts: number;
  tokens?: number;
  toolCalls?: unknown[];
  toolResults?: unknown[];
  citations?: unknown[];
  status?: AgentMessageStatus;
}

const MESSAGE_STATUS_VALUES = ['running', 'complete', 'truncated', 'error'] as const;
const asMessageStatus = (value: unknown): AgentMessageStatus | undefined =>
  (MESSAGE_STATUS_VALUES as readonly string[]).includes(value as string)
    ? (value as AgentMessageStatus)
    : undefined;

const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 30;
const MAX_MESSAGES_LIMIT = 500;
const DEFAULT_MESSAGES_LIMIT = 50;
// C5b: máximo de chats activos por usuario. Previene acumulación ilimitada en
// Firestore (storage abuse). El usuario debe borrar chats viejos para crear nuevos.
export const MAX_CHATS_PER_USER = 200;

export const clampListLimit = (raw: unknown): number => {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.floor(n), MAX_LIST_LIMIT);
};

export const clampMessagesLimit = (raw: unknown): number => {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MESSAGES_LIMIT;
  return Math.min(Math.floor(n), MAX_MESSAGES_LIMIT);
};

const toMillis = (value: unknown): number => {
  if (typeof value === 'number') return value;
  if (value && typeof (value as Timestamp).toMillis === 'function') return (value as Timestamp).toMillis();
  return 0;
};

const chatsCol = (uid: string) => adminDb.collection('users').doc(uid).collection('agentChats');
const messagesCol = (uid: string, chatId: string) => chatsCol(uid).doc(chatId).collection('messages');

// Firestore rechaza claves de mapa vacías ("") con
// "Element at index 0 should not be an empty string". Los payloads de tool
// results pueden traerlas (ej. `folderDocCountMap` con la raíz como ""), lo que
// haría fallar la escritura y dejar el mensaje assistant atascado en
// status:"running" para siempre. Reescribimos esas claves a "(raíz)" en
// profundidad para que la persistencia del progreso nunca se rompa por la
// forma del output de una tool.
const sanitizeFirestoreKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitizeFirestoreKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k === '' ? '(raíz)' : k] = sanitizeFirestoreKeys(v);
    }
    return out;
  }
  return value;
};
const sanitizeToolPayload = (items: unknown[]): unknown[] =>
  items.map((item) => sanitizeFirestoreKeys(item));

export class ChatLimitExceededError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`El usuario ha alcanzado el límite de ${limit} chats. Borra chats anteriores para continuar.`);
    this.name = 'ChatLimitExceededError';
    this.limit = limit;
  }
}

export const createAgentChat = async (uid: string, params: {
  title?: string;
  model?: string;
  provider?: typeof PROVIDER_VALUES[number];
  workspaceContext?: string;
}): Promise<AgentChatRecord> => {
  // C5b: verificar cap antes de escribir. Usamos una query count-only para
  // no descargar documentos innecesariamente.
  const countSnap = await chatsCol(uid).count().get();
  if (countSnap.data().count >= MAX_CHATS_PER_USER) {
    throw new ChatLimitExceededError(MAX_CHATS_PER_USER);
  }

  const ref = chatsCol(uid).doc();
  const now = Date.now();
  const data = {
    title: params.title?.trim() || 'Nuevo chat',
    createdAt: now,
    updatedAt: now,
    model: params.model?.trim() || '',
    provider: params.provider ?? null,
    workspaceContext: params.workspaceContext?.trim() || null,
    totalTokens: 0
  };
  await ref.set(data);
  return { id: ref.id, ...data };
};

export const getAgentChat = async (uid: string, chatId: string): Promise<AgentChatRecord | null> => {
  const snap = await chatsCol(uid).doc(chatId).get();
  if (!snap.exists) return null;
  const data = snap.data() as Record<string, unknown> | undefined;
  if (!data) return null;
  return {
    id: snap.id,
    title: typeof data.title === 'string' ? data.title : 'Nuevo chat',
    createdAt: toMillis(data.createdAt),
    updatedAt: toMillis(data.updatedAt),
    model: typeof data.model === 'string' ? data.model : '',
    provider: (PROVIDER_VALUES as readonly string[]).includes(data.provider as string)
      ? (data.provider as AgentChatRecord['provider'])
      : null,
    workspaceContext: typeof data.workspaceContext === 'string' ? data.workspaceContext : null,
    totalTokens: typeof data.totalTokens === 'number' ? data.totalTokens : 0
  };
};

export const listAgentChats = async (uid: string, params: {
  limit: number;
  cursor?: string | null;
}): Promise<{ items: AgentChatRecord[]; nextCursor: string | null }> => {
  let q = chatsCol(uid).orderBy('updatedAt', 'desc').limit(params.limit + 1);
  if (params.cursor) {
    const cursorSnap = await chatsCol(uid).doc(params.cursor).get();
    if (cursorSnap.exists) {
      q = q.startAfter(cursorSnap);
    }
  }
  const snap = await q.get();
  const docs = snap.docs.slice(0, params.limit);
  const items: AgentChatRecord[] = docs.map((doc) => {
    const data = doc.data() as Record<string, unknown>;
    return {
      id: doc.id,
      title: typeof data.title === 'string' ? data.title : 'Nuevo chat',
      createdAt: toMillis(data.createdAt),
      updatedAt: toMillis(data.updatedAt),
      model: typeof data.model === 'string' ? data.model : '',
      provider: (PROVIDER_VALUES as readonly string[]).includes(data.provider as string)
        ? (data.provider as AgentChatRecord['provider'])
        : null,
      workspaceContext: typeof data.workspaceContext === 'string' ? data.workspaceContext : null,
      totalTokens: typeof data.totalTokens === 'number' ? data.totalTokens : 0
    };
  });
  const nextCursor = snap.docs.length > params.limit ? (docs[docs.length - 1]?.id ?? null) : null;
  return { items, nextCursor };
};

export const patchAgentChat = async (uid: string, chatId: string, title: string): Promise<boolean> => {
  const ref = chatsCol(uid).doc(chatId);
  const snap = await ref.get();
  if (!snap.exists) return false;
  await ref.update({ title: title.trim(), updatedAt: Date.now() });
  return true;
};

export const deleteAgentChat = async (uid: string, chatId: string): Promise<boolean> => {
  const ref = chatsCol(uid).doc(chatId);
  const snap = await ref.get();
  if (!snap.exists) return false;

  // Borrar mensajes en lotes (Firestore admite hasta 500 ops por batch).
  // Cap conservador: 50 lotes × 400 = 20k mensajes por chat; suficiente.
  const msgsRef = messagesCol(uid, chatId);
  for (let i = 0; i < 50; i += 1) {
    const page = await msgsRef.limit(400).get();
    if (page.empty) break;
    const batch = adminDb.batch();
    page.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    if (page.size < 400) break;
  }
  await ref.delete();
  return true;
};

export const appendChatMessage = async (uid: string, chatId: string, payload: ChatMessageAppendPayload & { tokens?: number }): Promise<AgentChatMessageRecord> => {
  const ref = messagesCol(uid, chatId).doc();
  const ts = Date.now();
  const data: Record<string, unknown> = {
    role: payload.role,
    content: payload.content,
    ts
  };
  if (typeof payload.tokens === 'number' && payload.tokens > 0) data.tokens = payload.tokens;
  if (payload.toolCalls && payload.toolCalls.length) data.toolCalls = sanitizeToolPayload(payload.toolCalls);
  if (payload.toolResults && payload.toolResults.length) data.toolResults = sanitizeToolPayload(payload.toolResults);
  if (payload.citations && payload.citations.length) data.citations = sanitizeToolPayload(payload.citations);
  await ref.set(data);
  // Tocar updatedAt + sumar tokens en parent.
  const tokensInc = typeof payload.tokens === 'number' && payload.tokens > 0 ? payload.tokens : 0;
  await chatsCol(uid).doc(chatId).update({
    updatedAt: ts,
    ...(tokensInc > 0 ? { totalTokens: FieldValue.increment(tokensInc) } : {})
  });
  return { id: ref.id, role: payload.role, content: payload.content, ts, ...(typeof payload.tokens === 'number' && payload.tokens > 0 ? { tokens: payload.tokens } : {}), ...(payload.toolCalls ? { toolCalls: payload.toolCalls } : {}), ...(payload.toolResults ? { toolResults: payload.toolResults } : {}), ...(payload.citations ? { citations: payload.citations } : {}) };
};

/**
 * Crea/actualiza incrementalmente el mensaje assistant de un turno mientras el
 * stream corre. El caller fija `msgId` (estable durante todo el run) y `ts`
 * (timestamp en ms, FIJO para que el orden por `ts` no cambie entre updates),
 * y vuelve a llamar con el progreso (steps acumulados) y al final con el reply
 * completo + status terminal. Usa `set(..., { merge:true })` para que una sola
 * fila assistant represente el turno entero, sin duplicar.
 *
 * Tokens: para no doble-contar `totalTokens` del chat parent, sólo se suma el
 * incremento cuando `payload.tokens` viene (el caller lo pasa únicamente en el
 * upsert final), nunca en los updates intermedios `running`.
 */
export const upsertStreamingAssistantMessage = async (
  uid: string,
  chatId: string,
  msgId: string,
  ts: number,
  payload: {
    content: string;
    status: AgentMessageStatus;
    toolCalls?: unknown[];
    toolResults?: unknown[];
    tokens?: number;
  }
): Promise<void> => {
  const ref = messagesCol(uid, chatId).doc(msgId);
  const data: Record<string, unknown> = {
    role: 'assistant',
    content: payload.content,
    ts,
    status: payload.status
  };
  if (typeof payload.tokens === 'number' && payload.tokens > 0) data.tokens = payload.tokens;
  if (payload.toolCalls && payload.toolCalls.length) data.toolCalls = sanitizeToolPayload(payload.toolCalls);
  if (payload.toolResults && payload.toolResults.length) data.toolResults = sanitizeToolPayload(payload.toolResults);
  await ref.set(data, { merge: true });
  const tokensInc = typeof payload.tokens === 'number' && payload.tokens > 0 ? payload.tokens : 0;
  await chatsCol(uid).doc(chatId).update({
    updatedAt: Date.now(),
    ...(tokensInc > 0 ? { totalTokens: FieldValue.increment(tokensInc) } : {})
  });
};

export const listChatMessages = async (uid: string, chatId: string, params: {
  limit: number;
  cursor?: string | null;
}): Promise<{ items: AgentChatMessageRecord[]; nextCursor: string | null }> => {
  let q = messagesCol(uid, chatId).orderBy('ts', 'asc').limit(params.limit + 1);
  if (params.cursor) {
    const cursorSnap = await messagesCol(uid, chatId).doc(params.cursor).get();
    if (cursorSnap.exists) {
      q = q.startAfter(cursorSnap);
    }
  }
  const snap = await q.get();
  const docs = snap.docs.slice(0, params.limit);
  const items: AgentChatMessageRecord[] = docs.map((doc) => {
    const data = doc.data() as Record<string, unknown>;
    return {
      id: doc.id,
      role: (data.role === 'user' || data.role === 'assistant' || data.role === 'tool') ? data.role : 'assistant',
      content: typeof data.content === 'string' ? data.content : '',
      ts: toMillis(data.ts),
      ...(typeof data.tokens === 'number' && data.tokens > 0 ? { tokens: data.tokens } : {}),
      ...(Array.isArray(data.toolCalls) ? { toolCalls: data.toolCalls } : {}),
      ...(Array.isArray(data.toolResults) ? { toolResults: data.toolResults } : {}),
      ...(Array.isArray(data.citations) ? { citations: data.citations } : {}),
      ...(asMessageStatus(data.status) ? { status: asMessageStatus(data.status) } : {})
    };
  });
  const nextCursor = snap.docs.length > params.limit ? (docs[docs.length - 1]?.id ?? null) : null;
  return { items, nextCursor };
};

const deleteMessagesFromTs = async (
  uid: string,
  chatId: string,
  anchorTs: number
): Promise<number> => {
  const msgsRef = messagesCol(uid, chatId);
  let deleted = 0;
  for (let i = 0; i < 50; i += 1) {
    const page = await msgsRef.where('ts', '>=', anchorTs).orderBy('ts', 'asc').limit(400).get();
    if (page.empty) break;
    const batch = adminDb.batch();
    page.docs.forEach((d) => {
      batch.delete(d.ref);
      deleted += 1;
    });
    await batch.commit();
    if (page.size < 400) break;
  }
  await chatsCol(uid).doc(chatId).update({ updatedAt: Date.now() });
  return deleted;
};

/**
 * Trunca la conversación borrando el mensaje `fromMessageId` y todos los
 * posteriores (orden por `ts`). Devuelve la cantidad de mensajes borrados, o
 * `null` si el mensaje ancla no existe.
 */
export const truncateChatMessagesFrom = async (
  uid: string,
  chatId: string,
  fromMessageId: string
): Promise<number | null> => {
  const anchorSnap = await messagesCol(uid, chatId).doc(fromMessageId).get();
  if (!anchorSnap.exists) return null;
  const anchorTs = toMillis((anchorSnap.data() as Record<string, unknown>).ts);
  return deleteMessagesFromTs(uid, chatId, anchorTs);
};

/**
 * Trunca a partir del N-ésimo mensaje de rol `user` (0-based, orden por `ts`)
 * y todos los posteriores. Robusto para el checkpoint "volver aquí": el cliente
 * sólo conoce la posición del turno, no el doc id de Firestore (los mensajes
 * en vivo usan ids locales). El stream persiste exactamente 1 doc user + 1 doc
 * assistant por turno, así que el índice de user mapea 1:1 con la UI.
 * Devuelve la cantidad borrada, o `null` si no existe ese índice de user.
 */
export const truncateChatFromUserIndex = async (
  uid: string,
  chatId: string,
  userIndex: number
): Promise<number | null> => {
  if (!Number.isInteger(userIndex) || userIndex < 0) return null;
  const userMsgs = await messagesCol(uid, chatId)
    .where('role', '==', 'user')
    .orderBy('ts', 'asc')
    .limit(userIndex + 1)
    .get();
  const anchor = userMsgs.docs[userIndex];
  if (!anchor) return null;
  const anchorTs = toMillis((anchor.data() as Record<string, unknown>).ts);
  return deleteMessagesFromTs(uid, chatId, anchorTs);
};

export const deriveChatTitleFromContent = (content: string): string => {
  const cleaned = content.replace(/[#>*_`~-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'Nuevo chat';
  return cleaned.length > 80 ? `${cleaned.slice(0, 79)}…` : cleaned;
};

export { ok, err };
