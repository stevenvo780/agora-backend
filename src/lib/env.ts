/**
 * Lectura central de variables de entorno. Cada lector hace `.trim()` (CLAUDE.md
 * §2: newline silente rompe HMAC) y `requireProductionEnv` falla al boot si
 * falta una crítica en producción. Sin esta puerta, los bugs aparecen como
 * "401 Unauthorized random" en horarios pico.
 *
 * Uso: importa el helper, no leas process.env disperso.
 */

const trim = (k: string): string => (process.env[k] ?? '').trim();
const flag = (k: string): boolean => trim(k) === 'true';

const isProd = (): boolean => process.env.NODE_ENV === 'production';

export const env = {
  WORKER_SECRET: () => trim('WORKER_SECRET'),
  WORKER_SYNC_SECRET: () => trim('WORKER_SYNC_SECRET'),
  WORKER_SOCKET_SECRET: () => trim('WORKER_SOCKET_SECRET'),
  WORKER_SECRET_PREVIOUS: () => trim('WORKER_SECRET_PREVIOUS'),
  CRON_SECRET: () => trim('CRON_SECRET'),
  FORGEJO_API_URL: () => trim('FORGEJO_API_URL'),
  FORGEJO_ADMIN_TOKEN: () => trim('FORGEJO_ADMIN_TOKEN'),
  FORGEJO_ORG: () => trim('FORGEJO_ORG') || 'agora',
  NAS_S3_ENDPOINT: () => trim('NAS_S3_ENDPOINT'),
  NAS_S3_BUCKET: () => trim('NAS_S3_BUCKET'),
  NAS_S3_ACCESS_KEY: () => trim('NAS_S3_ACCESS_KEY'),
  NAS_S3_SECRET_KEY: () => trim('NAS_S3_SECRET_KEY'),
  FIREBASE_DATABASE_URL: () => trim('FIREBASE_DATABASE_URL'),
  FIREBASE_PROJECT_ID: () => trim('FIREBASE_PROJECT_ID'),
  MERCADOPAGO_ACCESS_TOKEN: () => trim('MERCADOPAGO_ACCESS_TOKEN'),
  MERCADOPAGO_WEBHOOK_SECRET: () => trim('MERCADOPAGO_WEBHOOK_SECRET'),
  ADMIN_PASSWORD: () => trim('APP_PASSWORD'),
  APP_BASE_URL: () => (trim('NEXT_PUBLIC_APP_URL') || trim('APP_BASE_URL') || 'https://agora.elenxos.com').replace(/\/+$/, ''),

  ALLOW_INSECURE_AUTH: () => flag('NEXT_PUBLIC_ALLOW_INSECURE_AUTH'),
  AGORA_USE_NAS: () => flag('AGORA_USE_NAS'),
  MERCADOPAGO_SANDBOX: () => flag('MERCADOPAGO_SANDBOX'),
  ENABLE_ADMIN_ENDPOINTS: () => flag('ENABLE_ADMIN_ENDPOINTS')
} as const;

export interface EnvCheck {
  ok: boolean;
  missing: string[];
  warnings: string[];
}

/**
 * Audita las env vars requeridas en producción. Se invoca al boot y debe
 * fallar rápido si falta una crítica: un deploy roto es preferible a una
 * API viva que responde 401/500 aleatorios en los bordes sensibles.
 */
export const auditProductionEnv = (): EnvCheck => {
  const missing: string[] = [];
  const warnings: string[] = [];
  if (!isProd()) return { ok: true, missing, warnings };

  const required: Array<keyof typeof env> = [
    'CRON_SECRET',
    'FORGEJO_API_URL',
    'FORGEJO_ADMIN_TOKEN',
    'NAS_S3_ENDPOINT',
    'NAS_S3_BUCKET',
    'NAS_S3_ACCESS_KEY',
    'NAS_S3_SECRET_KEY',
    'FIREBASE_DATABASE_URL'
  ];
  for (const k of required) {
    if (!env[k]()) missing.push(k);
  }

  if (!env.WORKER_SYNC_SECRET() && !env.WORKER_SECRET()) {
    missing.push('WORKER_SYNC_SECRET|WORKER_SECRET');
  }

  if (!env.WORKER_SYNC_SECRET() && env.WORKER_SECRET()) {
    warnings.push('WORKER_SYNC_SECRET no configurada — usando WORKER_SECRET legacy para sync HTTP');
  }

  if (env.ALLOW_INSECURE_AUTH()) {
    missing.push('NEXT_PUBLIC_ALLOW_INSECURE_AUTH=true');
  }

  if (env.ENABLE_ADMIN_ENDPOINTS() && !env.ADMIN_PASSWORD()) {
    missing.push('APP_PASSWORD');
  }

  const recommended: Array<keyof typeof env> = ['MERCADOPAGO_WEBHOOK_SECRET'];
  for (const k of recommended) {
    if (!env[k]()) warnings.push(`${k} no configurada — webhook de pagos rechazará eventos en producción`);
  }

  return { ok: missing.length === 0, missing, warnings };
};

let _audited = false;
export const auditOnce = (): void => {
  if (_audited) return;
  _audited = true;
  const r = auditProductionEnv();
  if (r.missing.length > 0) {
    throw new Error(`[env] FALTAN env vars críticas en prod: ${r.missing.join(', ')}`);
  }
  for (const w of r.warnings) console.warn('[env]', w);
};
