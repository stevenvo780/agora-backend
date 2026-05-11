/**
 * Storage de keys IA del usuario en Firestore.
 *
 *   users/{uid}/agentSecrets/{provider}
 *
 * El plaintext jamás se persiste ni se loguea. `displayHint` deja al user
 * identificar visualmente la key sin romper el contrato de cifrado.
 */
import { z } from 'zod';
import { adminDb } from '@/lib/firebase-admin';
import { type Timestamp } from 'firebase-admin/firestore';
import { parseZod, type ParseResult } from '@agora/contracts';
import {
  encryptAgentSecret,
  decryptAgentSecret,
  buildDisplayHint,
  CURRENT_KID
} from '@/lib/agora-ai/agentVault';

export const AGENT_PROVIDER_VALUES = ['openai', 'deepseek', 'anthropic', 'google', 'gemini', 'agora-gateway', 'custom'] as const;
export type AgentSecretProvider = typeof AGENT_PROVIDER_VALUES[number];

export const agentKeySaveSchema = z.object({
  provider: z.enum(AGENT_PROVIDER_VALUES),
  key: z.string().min(1).max(8000)
});
export type AgentKeySavePayload = z.infer<typeof agentKeySaveSchema>;
export const parseAgentKeySavePayload = (input: unknown): ParseResult<AgentKeySavePayload> =>
  parseZod(agentKeySaveSchema, input);

export interface AgentSecretSummary {
  provider: AgentSecretProvider;
  displayHint: string;
  createdAt: number;
  lastUsedAt: number | null;
  kid: string;
}

const toMillis = (value: unknown): number => {
  if (typeof value === 'number') return value;
  if (value && typeof (value as Timestamp).toMillis === 'function') return (value as Timestamp).toMillis();
  return 0;
};

const secretsCol = (uid: string) => adminDb.collection('users').doc(uid).collection('agentSecrets');

export const saveAgentSecret = async (uid: string, provider: AgentSecretProvider, plaintext: string): Promise<AgentSecretSummary> => {
  const trimmed = plaintext.trim();
  if (!trimmed) throw new Error('saveAgentSecret: plaintext vacío');
  const encrypted = encryptAgentSecret(trimmed);
  const displayHint = buildDisplayHint(trimmed);
  const ref = secretsCol(uid).doc(provider);
  const existing = await ref.get();
  const createdAt = existing.exists
    ? toMillis(existing.data()?.createdAt) || Date.now()
    : Date.now();
  const data = {
    keyEncrypted: encrypted.keyEncrypted,
    iv: encrypted.iv,
    authTag: encrypted.authTag,
    kid: encrypted.kid,
    displayHint,
    createdAt,
    lastUsedAt: null as number | null
  };
  await ref.set(data);
  return {
    provider,
    displayHint,
    createdAt,
    lastUsedAt: null,
    kid: encrypted.kid
  };
};

export const listAgentSecrets = async (uid: string): Promise<AgentSecretSummary[]> => {
  const snap = await secretsCol(uid).get();
  return snap.docs.map((doc) => {
    const data = doc.data() as Record<string, unknown>;
    return {
      provider: doc.id as AgentSecretProvider,
      displayHint: typeof data.displayHint === 'string' ? data.displayHint : '***',
      createdAt: toMillis(data.createdAt),
      lastUsedAt: data.lastUsedAt ? toMillis(data.lastUsedAt) : null,
      kid: typeof data.kid === 'string' ? data.kid : CURRENT_KID
    };
  });
};

export const deleteAgentSecret = async (uid: string, provider: AgentSecretProvider): Promise<boolean> => {
  const ref = secretsCol(uid).doc(provider);
  const snap = await ref.get();
  if (!snap.exists) return false;
  await ref.delete();
  return true;
};

/**
 * Lee y descifra la key del usuario para un provider. Devuelve null si no
 * existe o si el ciphertext no valida (key rota o `kid` desactualizado).
 * Toca `lastUsedAt` en best-effort — un fallo de update no impide el uso.
 */
export const readDecryptedAgentSecret = async (uid: string, provider: AgentSecretProvider): Promise<string | null> => {
  const ref = secretsCol(uid).doc(provider);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data() as Record<string, unknown> | undefined;
  if (!data) return null;
  const plaintext = decryptAgentSecret({
    keyEncrypted: typeof data.keyEncrypted === 'string' ? data.keyEncrypted : '',
    iv: typeof data.iv === 'string' ? data.iv : '',
    authTag: typeof data.authTag === 'string' ? data.authTag : '',
    kid: typeof data.kid === 'string' ? data.kid : ''
  });
  if (!plaintext) return null;
  // Touch lastUsedAt — no bloqueamos el descifrado si el update falla.
  ref.update({ lastUsedAt: Date.now() }).catch((error) => {
    console.warn('[agora-ai/agentSecrets] no se pudo actualizar lastUsedAt:', error instanceof Error ? error.message : error);
  });
  return plaintext;
};
