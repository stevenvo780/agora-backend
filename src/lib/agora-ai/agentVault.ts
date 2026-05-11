/**
 * Cifrado de API keys de proveedores IA por usuario.
 *
 * Reusa la derivación HKDF + AES-256-GCM de `git-remotes/secret-vault.ts`,
 * pero persiste los componentes (iv, authTag, ciphertext) en campos separados
 * de Firestore (no como string concatenada) para que la rotación de `kid` y
 * la auditoría de formato sean explícitas.
 */
import crypto from 'node:crypto';
import { env } from '@/lib/env';

const HKDF_INFO = Buffer.from('agora-agent-api-key-v1', 'utf8');
const HKDF_SALT = Buffer.from('agora-agent-secret-salt-2026', 'utf8');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
export const CURRENT_KID = 'k1';

let cachedKey: Buffer | null = null;

const deriveKey = (): Buffer => {
  if (cachedKey) return cachedKey;
  const ikm = env.WORKER_SECRET();
  if (!ikm) {
    throw new Error('WORKER_SECRET no configurado: imposible cifrar agent secrets');
  }
  cachedKey = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(ikm, 'utf8'), HKDF_SALT, HKDF_INFO, KEY_BYTES));
  return cachedKey;
};

export const __resetAgentVaultCache = (): void => {
  cachedKey = null;
};

export interface EncryptedAgentSecret {
  keyEncrypted: string;
  iv: string;
  authTag: string;
  kid: string;
}

export const isAgentVaultConfigured = (): boolean => {
  try {
    return env.WORKER_SECRET().length > 0;
  } catch {
    return false;
  }
};

export const encryptAgentSecret = (plaintext: string): EncryptedAgentSecret => {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('encryptAgentSecret: plaintext vacío');
  }
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    keyEncrypted: ct.toString('base64'),
    iv: iv.toString('base64'),
    authTag: tag.toString('base64'),
    kid: CURRENT_KID
  };
};

export const decryptAgentSecret = (record: EncryptedAgentSecret): string | null => {
  if (!record || typeof record !== 'object') return null;
  const { keyEncrypted, iv: ivB64, authTag: tagB64, kid } = record;
  if (kid !== CURRENT_KID) return null;
  if (typeof keyEncrypted !== 'string' || typeof ivB64 !== 'string' || typeof tagB64 !== 'string') return null;
  try {
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ct = Buffer.from(keyEncrypted, 'base64');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
    const key = deriveKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch {
    return null;
  }
};

export const buildDisplayHint = (apiKey: string): string => {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 4) return `***${trimmed}`;
  return `***${trimmed.slice(-4)}`;
};
