/**
 * Tests del cron `POST /api/cron/backfill-citations`.
 *
 * Cubre el parser puro de body (limit/stale/force) — la auth/integración
 * va por smoke contra el endpoint desplegado (logs y curl), porque el
 * handler depende de firebase-admin y no se testea en unit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCronBody } from '../src/app/api/cron/backfill-citations/route.ts';

test('parseCronBody: defaults cuando body vacío', () => {
  const parsed = parseCronBody({});
  assert.equal(parsed.limit, 20);
  assert.equal(parsed.staleAfterDays, 7);
  assert.equal(parsed.force, false);
});

test('parseCronBody: defaults cuando body no es objeto', () => {
  const parsed = parseCronBody(null);
  assert.equal(parsed.limit, 20);
  assert.equal(parsed.staleAfterDays, 7);
  assert.equal(parsed.force, false);
});

test('parseCronBody: clampa limit al rango [1, 100]', () => {
  assert.equal(parseCronBody({ limit: 0 }).limit, 1);
  assert.equal(parseCronBody({ limit: -10 }).limit, 1);
  assert.equal(parseCronBody({ limit: 50 }).limit, 50);
  assert.equal(parseCronBody({ limit: 1000 }).limit, 100);
});

test('parseCronBody: limit no numérico → default', () => {
  assert.equal(parseCronBody({ limit: 'abc' as unknown as number }).limit, 20);
  assert.equal(parseCronBody({ limit: NaN }).limit, 20);
});

test('parseCronBody: staleAfterDays acepta 0 (re-scan all)', () => {
  assert.equal(parseCronBody({ staleAfterDays: 0 }).staleAfterDays, 0);
  assert.equal(parseCronBody({ staleAfterDays: 14 }).staleAfterDays, 14);
  assert.equal(parseCronBody({ staleAfterDays: -5 }).staleAfterDays, 0);
});

test('parseCronBody: force booleano estricto (sólo true literal)', () => {
  assert.equal(parseCronBody({ force: true }).force, true);
  assert.equal(parseCronBody({ force: false }).force, false);
  assert.equal(parseCronBody({ force: 'true' as unknown as boolean }).force, false);
  assert.equal(parseCronBody({ force: 1 as unknown as boolean }).force, false);
});

test('parseCronBody: Math.floor en limit fraccionarios', () => {
  assert.equal(parseCronBody({ limit: 25.7 }).limit, 25);
  assert.equal(parseCronBody({ limit: 1.99 }).limit, 1);
});
