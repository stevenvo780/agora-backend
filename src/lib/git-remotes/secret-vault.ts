/**
 * Cifrado simétrico de secrets de remotes externos (tokens, SSH private keys).
 *
 * Estrategia (Option B del design): derivamos una key AES-256 con HKDF desde
 * `WORKER_SECRET` + un salt fijo por contexto. AEAD GCM con IV de 12 bytes y
 * tag de 16 bytes. Formato persistido: `v1:<base64(iv)>:<base64(tag)>:<base64(ct)>`.
 *
 * No persistimos plaintext, ni el ciphertext sin tag. Falla cerrado:
 * decryptSecret devuelve null si el formato o la firma no validan.
 */
import crypto from 'node:crypto';
import { env } from '@/lib/env';

const HKDF_INFO = Buffer.from('agora-git-remote-secret-v1', 'utf8');
const HKDF_SALT = Buffer.from('agora-remote-vault-salt-2026', 'utf8');
const FORMAT_VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;

const deriveKey = (): Buffer => {
  if (cachedKey) return cachedKey;
  const ikm = env.WORKER_SECRET();
  if (!ikm) {
    throw new Error('WORKER_SECRET no configurado: imposible cifrar secrets de remotes');
  }
  const ikmBuf = Buffer.from(ikm, 'utf8');
  cachedKey = Buffer.from(crypto.hkdfSync('sha256', ikmBuf, HKDF_SALT, HKDF_INFO, KEY_BYTES));
  return cachedKey;
};

/** Reinicia el cache de key (solo tests). */
export const __resetVaultCache = (): void => {
  cachedKey = null;
};

export interface VaultCipher {
  ciphertext: string;
  /** Identificador opaco para guardar como `authRef`. */
  ref: string;
}

export const isVaultConfigured = (): boolean => {
  try {
    return env.WORKER_SECRET().length > 0;
  } catch {
    return false;
  }
};

export const encryptSecret = (plaintext: string): VaultCipher => {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('encryptSecret: plaintext vacío');
  }
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = [
    FORMAT_VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ct.toString('base64')
  ].join(':');
  // ref es un hash del ciphertext (no del plaintext) para no exponerlo.
  const ref = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
  return { ciphertext: payload, ref };
};

export const decryptSecret = (payload: string): string | null => {
  if (typeof payload !== 'string') return null;
  const parts = payload.split(':');
  if (parts.length !== 4) return null;
  const [version, ivB64, tagB64, ctB64] = parts;
  if (version !== FORMAT_VERSION) return null;
  if (!ivB64 || !tagB64 || !ctB64) return null;
  try {
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
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

/**
 * Embebe un token en URL HTTPS (para git over https con auth básica). Solo
 * para uso interno en operaciones git push/pull; nunca loggear el resultado.
 */
export const buildAuthenticatedHttpsUrl = (rawUrl: string, token: string): string => {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('buildAuthenticatedHttpsUrl: solo https/http');
  }
  // Convención GitHub/GitLab: usuario `x-access-token` con token como password.
  url.username = 'x-access-token';
  url.password = encodeURIComponent(token);
  return url.toString();
};

/** Para no exponer el secret en logs/errores. */
export const redactSecretFromError = (msg: string, secret: string | null): string => {
  if (!secret || !msg) return msg;
  return msg.split(secret).join('***REDACTED***');
};
