import crypto from 'crypto';

const SCRYPT_PREFIX = 'scrypt';
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;

const hashLegacy = (password: string): string =>
  crypto.createHash('sha256').update(password).digest('hex');

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P
  });

  return [
    SCRYPT_PREFIX,
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64'),
    derived.toString('base64')
  ].join('$');
}

export async function verifyPassword(
  password: string,
  storedHash: string | undefined | null
): Promise<{ ok: boolean; needsUpgrade: boolean; newHash?: string }> {
  if (!storedHash) return { ok: false, needsUpgrade: false };

  if (storedHash.startsWith(`${SCRYPT_PREFIX}$`)) {
    const [, nRaw, rRaw, pRaw, saltB64, hashB64] = storedHash.split('$');
    const n = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);

    if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p) || !saltB64 || !hashB64) {
      return { ok: false, needsUpgrade: false };
    }

    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const derived = await scryptAsync(password, salt, expected.length, {
      N: n,
      r,
      p
    });

    const ok = expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
    return { ok, needsUpgrade: false };
  }

  const legacyHash = hashLegacy(password);
  const ok =
    legacyHash.length === storedHash.length &&
    crypto.timingSafeEqual(Buffer.from(legacyHash), Buffer.from(storedHash));

  if (!ok) return { ok: false, needsUpgrade: false };

  const newHash = await hashPassword(password);
  return { ok: true, needsUpgrade: true, newHash };
}
