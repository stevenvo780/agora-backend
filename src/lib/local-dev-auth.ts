import crypto from 'crypto';
import { getErrorMessage } from '@/lib/error-utils';

const LOCAL_DEV_AUTH_ISSUER = 'agora-local-dev';
const LOCAL_DEV_AUTH_AUDIENCE = 'agora-local-dev';
const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60 * 12;

type LocalDevAuthTokenPayload = {
  uid: string;
  email?: string | null;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
};

const encodeBase64Url = (value: Buffer | string) =>
  Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

const decodeBase64Url = (value: string) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8');
};

const getLocalDevAuthSecret = () => {
  const secret = process.env.APP_PASSWORD?.trim();
  return secret && process.env.NODE_ENV !== 'production' ? secret : null;
};

const sign = (unsignedToken: string, secret: string) =>
  encodeBase64Url(crypto.createHmac('sha256', secret).update(unsignedToken).digest());

export const supportsLocalDevAuth = () => Boolean(getLocalDevAuthSecret());

export const createLocalDevAuthToken = (params: { uid: string; email?: string | null; ttlSeconds?: number }) => {
  const secret = getLocalDevAuthSecret();
  if (!secret) return null;

  const now = Math.floor(Date.now() / 1000);
  const payload: LocalDevAuthTokenPayload = {
    uid: params.uid,
    email: params.email ?? null,
    iat: now,
    exp: now + (params.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS),
    iss: LOCAL_DEV_AUTH_ISSUER,
    aud: LOCAL_DEV_AUTH_AUDIENCE
  };

  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = encodeBase64Url(JSON.stringify(header));
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const signature = sign(unsignedToken, secret);
  return `${unsignedToken}.${signature}`;
};

export const verifyLocalDevAuthToken = (token: string) => {
  const secret = getLocalDevAuthSecret();
  if (!secret) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const encodedHeader = parts[0];
  const encodedPayload = parts[1];
  const providedSignature = parts[2];
  if (!encodedHeader || !encodedPayload || !providedSignature) return null;
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = sign(unsignedToken, secret);

  const providedBuffer = Buffer.from(providedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (providedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(decodeBase64Url(encodedPayload)) as LocalDevAuthTokenPayload;
    if (payload.iss !== LOCAL_DEV_AUTH_ISSUER || payload.aud !== LOCAL_DEV_AUTH_AUDIENCE) {
      return null;
    }
    if (typeof payload.uid !== 'string' || !payload.uid.trim()) {
      return null;
    }
    if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }

    return {
      uid: payload.uid,
      email: typeof payload.email === 'string' ? payload.email : null
    };
  } catch {
    return null;
  }
};

export const shouldUseLocalDevAuthFallback = (error: unknown) => {
  if (!supportsLocalDevAuth()) return false;
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes('serviceusage.serviceusageconsumer')
    || message.includes('serviceusage.services.use')
    || message.includes('user_project_denied')
    || message.includes('identitytoolkit.googleapis.com')
    || message.includes('caller does not have required permission to use project')
  );
};