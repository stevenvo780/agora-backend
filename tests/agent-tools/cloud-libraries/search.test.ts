import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyLibraryFilters,
  LIBRARY_SEARCH_LIMITS,
  matchesProfileFilter,
  matchesTagFilter,
  normalizeLimit,
  type STLibrary
} from '../../../src/lib/cloud-libraries/index.ts';

const libBase = (over: Partial<STLibrary>): STLibrary => ({
  id: 'x',
  name: 'x',
  description: '',
  owner: { uid: 'alice' },
  visibility: 'public',
  claims: [],
  consumers: [],
  createdAt: '2026-05-17T00:00:00.000Z',
  updatedAt: '2026-05-17T00:00:00.000Z',
  version: '0.1.0',
  ...over
});

const libs: STLibrary[] = [
  libBase({
    id: 'modal',
    owner: { uid: 'alice' },
    visibility: 'public',
    claims: [{ id: 'K', formula: '□p', profile: 'K', kind: 'axiom', tags: ['modal'] }]
  }),
  libBase({
    id: 'classical',
    owner: { uid: 'alice' },
    visibility: 'private',
    claims: [{ id: 'EM', formula: 'p∨¬p', profile: 'CL', kind: 'axiom', tags: ['classical'] }]
  }),
  libBase({
    id: 'paraconsistent',
    owner: { uid: 'bob' },
    visibility: 'public',
    claims: [{ id: 'LP', formula: 'p', profile: 'LP', kind: 'axiom' }]
  })
];

test('normalizeLimit: undefined retorna default', () => {
  assert.equal(normalizeLimit(undefined), LIBRARY_SEARCH_LIMITS.DEFAULT_LIMIT);
});

test('normalizeLimit: valores fuera de rango se acotan', () => {
  assert.equal(normalizeLimit(0), LIBRARY_SEARCH_LIMITS.DEFAULT_LIMIT);
  assert.equal(normalizeLimit(-5), LIBRARY_SEARCH_LIMITS.DEFAULT_LIMIT);
  assert.equal(normalizeLimit(10_000), LIBRARY_SEARCH_LIMITS.MAX_LIMIT);
  assert.equal(normalizeLimit(25), 25);
});

test('matchesProfileFilter: encuentra perfil dentro de claims', () => {
  assert.equal(matchesProfileFilter(libs[0]!, 'K'), true);
  assert.equal(matchesProfileFilter(libs[0]!, 'CL'), false);
});

test('matchesTagFilter: encuentra tag dentro de claims', () => {
  assert.equal(matchesTagFilter(libs[0]!, 'modal'), true);
  assert.equal(matchesTagFilter(libs[2]!, 'modal'), false);
});

test('applyLibraryFilters: filtra por ownerUid', () => {
  const out = applyLibraryFilters(libs, { ownerUid: 'alice' });
  assert.deepEqual(out.map((l) => l.id).sort(), ['classical', 'modal']);
});

test('applyLibraryFilters: filtra por visibility', () => {
  const out = applyLibraryFilters(libs, { visibility: 'public' });
  assert.deepEqual(out.map((l) => l.id).sort(), ['modal', 'paraconsistent']);
});

test('applyLibraryFilters: filtra por profile', () => {
  const out = applyLibraryFilters(libs, { profile: 'LP' });
  assert.deepEqual(out.map((l) => l.id), ['paraconsistent']);
});

test('applyLibraryFilters: filtra por tag', () => {
  const out = applyLibraryFilters(libs, { tag: 'classical' });
  assert.deepEqual(out.map((l) => l.id), ['classical']);
});

test('applyLibraryFilters: combina filtros (owner + visibility)', () => {
  const out = applyLibraryFilters(libs, { ownerUid: 'alice', visibility: 'public' });
  assert.deepEqual(out.map((l) => l.id), ['modal']);
});

test('applyLibraryFilters: respeta limit', () => {
  const out = applyLibraryFilters(libs, { limit: 1 });
  assert.equal(out.length, 1);
});
