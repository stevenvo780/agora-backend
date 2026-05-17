import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canMutateLibrary,
  canReadLibrary,
  filterReadableLibraries,
  isLibraryOwner,
  type STLibrary
} from '../../../src/lib/cloud-libraries/index.ts';

const baseLibrary = (over: Partial<STLibrary> = {}): STLibrary => ({
  id: 'lib-1',
  name: 'Test',
  description: 'desc',
  owner: { uid: 'alice' },
  visibility: 'private',
  claims: [],
  consumers: [],
  createdAt: '2026-05-17T00:00:00.000Z',
  updatedAt: '2026-05-17T00:00:00.000Z',
  version: '0.1.0',
  ...over
});

test('isLibraryOwner: solo el owner uid retorna true', () => {
  const lib = baseLibrary();
  assert.equal(isLibraryOwner(lib, { uid: 'alice' }), true);
  assert.equal(isLibraryOwner(lib, { uid: 'bob' }), false);
});

test('canReadLibrary: owner siempre puede leer aunque sea private', () => {
  const lib = baseLibrary({ visibility: 'private' });
  assert.equal(canReadLibrary(lib, { uid: 'alice' }), true);
});

test('canReadLibrary: private bloquea a otros uids', () => {
  const lib = baseLibrary({ visibility: 'private' });
  assert.equal(canReadLibrary(lib, { uid: 'bob' }), false);
  assert.equal(canReadLibrary(lib, { uid: 'bob', workspaceId: 'ws-1' }), false);
});

test('canReadLibrary: public deja leer a cualquiera autenticado', () => {
  const lib = baseLibrary({ visibility: 'public' });
  assert.equal(canReadLibrary(lib, { uid: 'bob' }), true);
  assert.equal(canReadLibrary(lib, { uid: 'carol', workspaceId: 'ws-9' }), true);
});

test('canReadLibrary: workspace permite si owner.workspaceId coincide con requester', () => {
  const lib = baseLibrary({
    visibility: 'workspace',
    owner: { uid: 'alice', workspaceId: 'ws-1' }
  });
  assert.equal(canReadLibrary(lib, { uid: 'bob', workspaceId: 'ws-1' }), true);
  assert.equal(canReadLibrary(lib, { uid: 'bob', workspaceId: 'ws-2' }), false);
  assert.equal(canReadLibrary(lib, { uid: 'bob' }), false);
});

test('canReadLibrary: workspace permite si requester.workspaceId está en consumers', () => {
  const lib = baseLibrary({
    visibility: 'workspace',
    owner: { uid: 'alice', workspaceId: 'ws-1' },
    consumers: ['ws-2']
  });
  assert.equal(canReadLibrary(lib, { uid: 'bob', workspaceId: 'ws-2' }), true);
  assert.equal(canReadLibrary(lib, { uid: 'bob', workspaceId: 'ws-3' }), false);
});

test('canMutateLibrary: solo el owner uid puede mutar', () => {
  const lib = baseLibrary({ visibility: 'public' });
  assert.equal(canMutateLibrary(lib, { uid: 'alice' }), true);
  assert.equal(canMutateLibrary(lib, { uid: 'bob' }), false);
});

test('filterReadableLibraries: descarta privadas de terceros y conserva public/owned', () => {
  const libs: STLibrary[] = [
    baseLibrary({ id: 'a', visibility: 'public' }),
    baseLibrary({ id: 'b', visibility: 'private', owner: { uid: 'bob' } }),
    baseLibrary({ id: 'c', visibility: 'private', owner: { uid: 'alice' } })
  ];
  const visible = filterReadableLibraries(libs, { uid: 'alice' });
  const ids = visible.map((l) => l.id).sort();
  assert.deepEqual(ids, ['a', 'c']);
});
