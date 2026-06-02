/**
 * Tests del cron `GET /api/cron/drain-outbox` (núcleo puro `drainOutboxDocs`).
 *
 * Bug HIGH: el drainer reportaba `drained` sin garantizar que el evento llegó
 * a RTDB ni que el doc quedó marcado (silent loss + re-drenado), y el write a
 * RTDB podía colgar el handler indefinidamente.
 *
 * Invariantes que fijamos:
 *   - `drained` cuenta SOLO eventos publicados a RTDB Y con doc marcado.
 *   - publish que falla NO cuenta como drained → `failed++` y se registra.
 *   - markPublished que falla NO cuenta como drained (no silent-loss).
 *   - docs corruptos / viejos / sin reintentos se expiran (no se reprocesan).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseOutboxRecord } from '@agora/contracts';
import { drainOutboxDocs, type DrainDeps } from '../src/app/api/cron/drain-outbox/route.ts';

const NOW = 1_700_000_000_000;

const makeRec = (overrides: Record<string, unknown> = {}) => ({
  rtdbPath: 'sync-events/qa-ws',
  published: false,
  retryCount: 0,
  ts: NOW - 1000,
  type: 'updated',
  path: 'qa/file.txt',
  source: 'worker',
  ...overrides
});

interface Spy {
  deps: DrainDeps;
  published: string[];
  failed: { id: string; retryCount: number; error: string }[];
  expired: string[];
}

const makeSpy = (over: Partial<DrainDeps> = {}): Spy => {
  const published: string[] = [];
  const failed: { id: string; retryCount: number; error: string }[] = [];
  const expired: string[] = [];
  const deps: DrainDeps = {
    publish: async () => undefined,
    markPublished: async (id) => {
      published.push(id);
    },
    markFailed: async (id, retryCount, error) => {
      failed.push({ id, retryCount, error });
    },
    expire: async (id) => {
      expired.push(id);
    },
    ...over
  };
  return { deps, published, failed, expired };
};

test('1 evento válido → drained=1, doc marcado, sin failed/expired', async () => {
  const candidates = [{ id: 'doc-1', parsed: parseOutboxRecord('doc-1', makeRec()) }];
  const spy = makeSpy();

  const res = await drainOutboxDocs(candidates, spy.deps, NOW);

  assert.equal(res.drained, 1);
  assert.equal(res.failed, 0);
  assert.equal(res.expired, 0);
  assert.equal(res.total, 1);
  assert.deepEqual(spy.published, ['doc-1']);
});

test('publish falla → NO cuenta como drained, failed=1, markFailed con retryCount+1', async () => {
  const candidates = [{ id: 'doc-1', parsed: parseOutboxRecord('doc-1', makeRec({ retryCount: 2 })) }];
  const spy = makeSpy({
    publish: async () => {
      throw new Error('rtdb down');
    }
  });

  const res = await drainOutboxDocs(candidates, spy.deps, NOW);

  assert.equal(res.drained, 0);
  assert.equal(res.failed, 1);
  assert.equal(res.expired, 0);
  assert.deepEqual(spy.published, []);
  assert.equal(spy.failed.length, 1);
  assert.equal(spy.failed[0]?.retryCount, 3);
  assert.match(spy.failed[0]?.error ?? '', /rtdb down/);
});

test('publish que cuelga simulado por rechazo de timeout → failed, no drained', async () => {
  const candidates = [{ id: 'doc-1', parsed: parseOutboxRecord('doc-1', makeRec()) }];
  const spy = makeSpy({
    publish: async () => {
      throw new Error('rtdb publish timed out after 8000ms');
    }
  });

  const res = await drainOutboxDocs(candidates, spy.deps, NOW);

  assert.equal(res.drained, 0);
  assert.equal(res.failed, 1);
  assert.match(spy.failed[0]?.error ?? '', /timed out/);
});

test('markPublished falla tras publish OK → NO drained (sin silent-loss), failed=1', async () => {
  const candidates = [{ id: 'doc-1', parsed: parseOutboxRecord('doc-1', makeRec()) }];
  const spy = makeSpy({
    markPublished: async () => {
      throw new Error('firestore update failed');
    }
  });

  const res = await drainOutboxDocs(candidates, spy.deps, NOW);

  assert.equal(res.drained, 0);
  assert.equal(res.failed, 1);
});

test('doc corrupto (sin rtdbPath) → expired, sin publish', async () => {
  const candidates = [{ id: 'doc-bad', parsed: parseOutboxRecord('doc-bad', { foo: 'bar' }) }];
  let publishCalls = 0;
  const spy = makeSpy({
    publish: async () => {
      publishCalls++;
    }
  });

  const res = await drainOutboxDocs(candidates, spy.deps, NOW);

  assert.equal(res.expired, 1);
  assert.equal(res.drained, 0);
  assert.equal(publishCalls, 0);
  assert.deepEqual(spy.expired, ['doc-bad']);
});

test('doc viejo (> 24h) → expired', async () => {
  const old = makeRec({ ts: NOW - 25 * 60 * 60 * 1000 });
  const candidates = [{ id: 'doc-old', parsed: parseOutboxRecord('doc-old', old) }];
  const spy = makeSpy();

  const res = await drainOutboxDocs(candidates, spy.deps, NOW);

  assert.equal(res.expired, 1);
  assert.equal(res.drained, 0);
});

test('doc sin reintentos (retryCount >= 5) → expired', async () => {
  const candidates = [{ id: 'doc-x', parsed: parseOutboxRecord('doc-x', makeRec({ retryCount: 5 })) }];
  const spy = makeSpy();

  const res = await drainOutboxDocs(candidates, spy.deps, NOW);

  assert.equal(res.expired, 1);
  assert.equal(res.drained, 0);
});

test('mezcla: 1 ok + 1 falla + 1 expirado → conteos independientes', async () => {
  const candidates = [
    { id: 'ok', parsed: parseOutboxRecord('ok', makeRec()) },
    { id: 'fail', parsed: parseOutboxRecord('fail', makeRec()) },
    { id: 'old', parsed: parseOutboxRecord('old', makeRec({ ts: NOW - 48 * 60 * 60 * 1000 })) }
  ];
  const spy = makeSpy({
    publish: async (path) => {
      if (path === 'sync-events/qa-ws' && false) return;
    }
  });
  // publish falla solo para 'fail': lo distinguimos por payload, así que
  // usamos un publish que rechaza la segunda invocación.
  let call = 0;
  spy.deps.publish = async () => {
    call++;
    if (call === 2) throw new Error('boom');
  };

  const res = await drainOutboxDocs(candidates, spy.deps, NOW);

  assert.equal(res.drained, 1);
  assert.equal(res.failed, 1);
  assert.equal(res.expired, 1);
  assert.equal(res.total, 3);
});
