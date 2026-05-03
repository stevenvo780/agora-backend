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
 * Audita las env vars requeridas en producción. Llamada al primer hit de
 * cualquier endpoint sensible — si falta algo se loguea WARN (NO matamos
 * el proceso para no tirar el deploy entero, pero el warn es muy ruidoso).
 *
 * Para prod ideal: invocar al boot del server y hacer crash si falta.
 */
export const auditProductionEnv = (): EnvCheck => {
  const missing: string[] = [];
  const warnings: string[] = [];
  if (!isProd()) return { ok: true, missing, warnings };

  const required: Array<keyof typeof env> = [
    'WORKER_SECRET',
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

  const recommended: Array<keyof typeof env> = ['MERCADOPAGO_WEBHOOK_SECRET'];
  for (const k of recommended) {
    if (!env[k]()) warnings.push(`${k} no configurada — endpoint en modo permisivo`);
  }

  return { ok: missing.length === 0, missing, warnings };
};

let _audited = false;
export const auditOnce = (): void => {
  if (_audited) return;
  _audited = true;
  const r = auditProductionEnv();
  if (r.missing.length > 0) {
    console.error('[env] FALTAN env vars críticas en prod:', r.missing.join(', '));
  }
  for (const w of r.warnings) console.warn('[env]', w);
};
