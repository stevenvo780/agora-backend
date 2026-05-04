import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildWorkerAuthSignature,
  verifyWorkerAuth
} from '../src/lib/worker-auth.ts';
import {
  buildMercadoPagoWebhookSignature,
  verifyMercadoPagoWebhookSignature
} from '../src/lib/payments/mercadoPagoWebhookSignature.ts';
import {
  isInternalToolSecretAuthorized,
  resolveInternalToolSecret
} from '../src/lib/agora-ai/internalToolAuth.ts';
import { auditProductionEnv } from '../src/lib/env.ts';
import { getBareApiRouteDeprecationHeaders, computeBareApiPath } from '../src/routes/nextApiRouter.ts';

const workerHmacFixture = JSON.parse(readFileSync('../packages/agora-contracts/fixtures/worker-hmac.json', 'utf8'));

const withEnv = (updates: Record<string, string | undefined>, fn: () => void) => {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(updates)) {
    previous.set(key, process.env[key]);
    const nextValue = updates[key];
    if (nextValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = nextValue;
    }
  }

  try {
    fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

const requiredProductionEnv = {
  WORKER_SECRET: 'worker-secret',
  CRON_SECRET: 'cron-secret',
  FORGEJO_API_URL: 'https://forgejo.example.test',
  FORGEJO_ADMIN_TOKEN: 'forgejo-token',
  NAS_S3_ENDPOINT: 'https://s3.example.test',
  NAS_S3_BUCKET: 'agora-blobs',
  NAS_S3_ACCESS_KEY: 'access-key',
  NAS_S3_SECRET_KEY: 'secret-key',
  FIREBASE_DATABASE_URL: 'https://firebase.example.test'
};

test('worker HMAC firma shared workspace con token:ts', () => {
  const sync = workerHmacFixture.syncHttp;
  const sig = buildWorkerAuthSignature(sync.secret, sync.workspaceId, sync.timestamp);
  assert.equal(sig, sync.sharedSignature);
});

test('worker HMAC incluye uid en personal workspace', () => {
  const sync = workerHmacFixture.syncHttp;
  const withUid = buildWorkerAuthSignature(sync.secret, sync.personalWorkspaceId, sync.timestamp, sync.userId);
  const withoutUid = buildWorkerAuthSignature(sync.secret, sync.personalWorkspaceId, sync.timestamp);
  assert.equal(withUid, sync.personalSignature);
  assert.notEqual(withUid, withoutUid);
});

test('verifyWorkerAuth acepta firma válida y rechaza firma alterada', async () => {
  process.env.WORKER_SYNC_SECRET = 'test-worker-secret';
  const mod = await import(`../src/lib/worker-auth.ts?case=${Date.now()}`);
  const ts = Date.now();
  const goodSig = mod.buildWorkerAuthSignature('test-worker-secret', 'workspace-1', ts);
  const req = (sig: string) => ({
    headers: {
      get(name: string) {
        const headers: Record<string, string> = {
          'x-worker-token': 'workspace-1',
          'x-worker-ts': String(ts),
          'x-worker-sig': sig
        };
        return headers[name.toLowerCase()] ?? null;
      }
    }
  });

  assert.deepEqual(mod.verifyWorkerAuth(req(goodSig)), { workspaceId: 'workspace-1', userId: null, ts });
  const badSig = `${goodSig.slice(0, -1)}${goodSig.endsWith('0') ? '1' : '0'}`;
  assert.equal(mod.verifyWorkerAuth(req(badSig)), null);
});

test('verifyWorkerAuth acepta WORKER_SECRET_PREVIOUS durante rotación', async () => {
  withEnv({
    WORKER_SYNC_SECRET: 'next-worker-secret',
    WORKER_SECRET: undefined,
    WORKER_SECRET_PREVIOUS: 'previous-worker-secret'
  }, () => {
    const ts = Date.now();
    const sig = buildWorkerAuthSignature('previous-worker-secret', 'workspace-1', ts);
    const req = {
      headers: {
        get(name: string) {
          const headers: Record<string, string> = {
            'x-worker-token': 'workspace-1',
            'x-worker-ts': String(ts),
            'x-worker-sig': sig
          };
          return headers[name.toLowerCase()] ?? null;
        }
      }
    };
    assert.deepEqual(verifyWorkerAuth(req as never), { workspaceId: 'workspace-1', userId: null, ts });
  });
});

test('MercadoPago webhook signature valida manifest oficial', () => {
  const secret = 'mp-secret';
  const dataId = '123456';
  const requestId = 'request-abc';
  const ts = '1700000000';
  const v1 = buildMercadoPagoWebhookSignature(secret, dataId, requestId, ts);

  assert.equal(verifyMercadoPagoWebhookSignature({
    secret,
    signatureHeader: `ts=${ts},v1=${v1}`,
    requestId,
    dataId,
    nodeEnv: 'production'
  }), true);
});

test('MercadoPago webhook falla cerrado en producción sin secret', () => {
  assert.equal(verifyMercadoPagoWebhookSignature({
    secret: '',
    signatureHeader: '',
    requestId: '',
    dataId: '123',
    nodeEnv: 'production'
  }), false);
  assert.equal(verifyMercadoPagoWebhookSignature({
    secret: '',
    signatureHeader: '',
    requestId: '',
    dataId: '123',
    nodeEnv: 'test'
  }), true);
});

test('internal execute-tool secret prefiere BACKEND y rechaza vacío', () => {
  assert.equal(resolveInternalToolSecret({ BACKEND_INTERNAL_SECRET: ' backend ', HUB_INTERNAL_SECRET: 'hub' }), 'backend');
  assert.equal(resolveInternalToolSecret({ HUB_INTERNAL_SECRET: ' hub ' }), 'hub');
  assert.equal(isInternalToolSecretAuthorized('backend', 'backend'), true);
  assert.equal(isInternalToolSecretAuthorized('hub', 'backend'), false);
  assert.equal(isInternalToolSecretAuthorized('', ''), false);
});

test('env audit bloquea auth insegura en producción', () => {
  withEnv({
    NODE_ENV: 'production',
    ...requiredProductionEnv,
    NEXT_PUBLIC_ALLOW_INSECURE_AUTH: 'true'
  }, () => {
    const result = auditProductionEnv();
    assert.equal(result.ok, false);
    assert.match(result.missing.join(','), /NEXT_PUBLIC_ALLOW_INSECURE_AUTH=true/);
  });
});

test('env audit acepta WORKER_SYNC_SECRET y mantiene WORKER_SECRET como fallback legacy', () => {
  withEnv({
    NODE_ENV: 'production',
    ...requiredProductionEnv,
    WORKER_SECRET: undefined,
    WORKER_SYNC_SECRET: 'sync-secret'
  }, () => {
    const result = auditProductionEnv();
    assert.equal(result.ok, true);
    assert.equal(result.missing.includes('WORKER_SYNC_SECRET|WORKER_SECRET'), false);
  });

  withEnv({
    NODE_ENV: 'production',
    ...requiredProductionEnv,
    WORKER_SYNC_SECRET: undefined
  }, () => {
    const result = auditProductionEnv();
    assert.equal(result.ok, true);
    assert.match(result.warnings.join(','), /WORKER_SYNC_SECRET/);
  });
});

test('env audit exige APP_PASSWORD si admin endpoints se habilitan en producción', () => {
  withEnv({
    NODE_ENV: 'production',
    ...requiredProductionEnv,
    ENABLE_ADMIN_ENDPOINTS: 'true',
    APP_PASSWORD: undefined
  }, () => {
    const result = auditProductionEnv();
    assert.equal(result.ok, false);
    assert.match(result.missing.join(','), /APP_PASSWORD/);
  });
});

test('rutas bare deprecated anuncian canonical y sunset', () => {
  assert.deepEqual(getBareApiRouteDeprecationHeaders('/api/documents'), {
    Deprecation: 'true',
    Sunset: '2026-08-01',
    Link: '</api/documents>; rel="canonical"'
  });
});

test('computeBareApiPath remueve prefijo /api preservando segmentos', () => {
  assert.equal(computeBareApiPath('/api/documents'), '/documents');
  assert.equal(computeBareApiPath('/api'), '/');
  assert.equal(computeBareApiPath('/api/sync/worker-list'), '/sync/worker-list');
  assert.equal(computeBareApiPath('/api/users/:id'), '/users/:id');
  assert.equal(computeBareApiPath('/health'), '/health');
});
