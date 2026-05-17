/**
 * Tests de ciclo de vida sobre un store en memoria que reproduce los contratos
 * de createLibrary/getLibrary/updateLibrary/deleteLibrary/subscribeLibrary.
 * No tocamos firebase-admin: la lógica de autorización vive en visibility.ts
 * y se valida aquí end-to-end componiéndola con un store stub.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyLibraryFilters,
  canMutateLibrary,
  canReadLibrary,
  parseLibraryCreateInput,
  parseLibraryUpdatePatch,
  type LibraryListFilter,
  type LibraryRequester,
  type STLibrary,
  type STLibraryCreateInput,
  type STLibraryUpdatePatch
} from '../../../src/lib/cloud-libraries/index.ts';

class MemoryStore {
  private items = new Map<string, STLibrary>();
  private seq = 0;

  create(input: STLibraryCreateInput): STLibrary {
    const id = `lib-${++this.seq}`;
    const now = new Date().toISOString();
    const lib: STLibrary = {
      id,
      name: input.name,
      description: input.description,
      owner: { ...input.owner },
      visibility: input.visibility,
      claims: input.claims,
      consumers: [],
      createdAt: now,
      updatedAt: now,
      version: input.version
    };
    this.items.set(id, lib);
    return lib;
  }

  get(id: string, requester: LibraryRequester): STLibrary | null {
    const lib = this.items.get(id);
    if (!lib) return null;
    return canReadLibrary(lib, requester) ? lib : null;
  }

  update(id: string, patch: STLibraryUpdatePatch, requester: Pick<LibraryRequester, 'uid'>): STLibrary {
    const lib = this.items.get(id);
    if (!lib) throw new Error('not-found');
    if (!canMutateLibrary(lib, requester)) throw new Error('forbidden');
    const next: STLibrary = {
      ...lib,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
      ...(patch.claims !== undefined ? { claims: patch.claims } : {}),
      ...(patch.version !== undefined ? { version: patch.version } : {}),
      updatedAt: new Date().toISOString()
    };
    this.items.set(id, next);
    return next;
  }

  delete(id: string, requester: Pick<LibraryRequester, 'uid'>): boolean {
    const lib = this.items.get(id);
    if (!lib) return false;
    if (!canMutateLibrary(lib, requester)) throw new Error('forbidden');
    this.items.delete(id);
    return true;
  }

  list(filter: LibraryListFilter): STLibrary[] {
    return applyLibraryFilters(Array.from(this.items.values()), filter);
  }

  subscribe(id: string, workspaceId: string, requester: LibraryRequester): void {
    const lib = this.items.get(id);
    if (!lib) throw new Error('not-found');
    if (!canReadLibrary(lib, requester)) throw new Error('forbidden');
    if (!lib.consumers.includes(workspaceId)) {
      lib.consumers = [...lib.consumers, workspaceId];
      lib.updatedAt = new Date().toISOString();
      this.items.set(id, lib);
    }
  }
}

const validRaw = (over: Record<string, unknown> = {}) => ({
  name: 'Modal',
  description: 'desc',
  owner: { uid: 'alice' },
  visibility: 'public',
  version: '1.0.0',
  claims: [{ id: 'K', formula: '□p', profile: 'K', kind: 'axiom', tags: ['modal'] }],
  ...over
});

const parseOrThrow = (raw: unknown): STLibraryCreateInput => {
  const parsed = parseLibraryCreateInput(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

test('create → get roundtrip preserva campos', () => {
  const store = new MemoryStore();
  const input = parseOrThrow(validRaw());
  const created = store.create(input);
  const fetched = store.get(created.id, { uid: 'alice' });
  assert.ok(fetched);
  assert.equal(fetched!.name, 'Modal');
  assert.equal(fetched!.claims.length, 1);
  assert.deepEqual(fetched!.consumers, []);
  assert.equal(fetched!.version, '1.0.0');
});

test('private no se puede ver desde otro uid', () => {
  const store = new MemoryStore();
  const input = parseOrThrow(validRaw({ visibility: 'private' }));
  const created = store.create(input);
  assert.equal(store.get(created.id, { uid: 'alice' }) !== null, true);
  assert.equal(store.get(created.id, { uid: 'bob' }), null);
});

test('update solo el owner', () => {
  const store = new MemoryStore();
  const input = parseOrThrow(validRaw());
  const created = store.create(input);

  const patchResult = parseLibraryUpdatePatch({ name: 'Renombrada' });
  assert.equal(patchResult.ok, true);
  if (!patchResult.ok) return;

  const updated = store.update(created.id, patchResult.value, { uid: 'alice' });
  assert.equal(updated.name, 'Renombrada');

  assert.throws(() => store.update(created.id, patchResult.value, { uid: 'bob' }), /forbidden/);
});

test('delete solo el owner', () => {
  const store = new MemoryStore();
  const created = store.create(parseOrThrow(validRaw()));

  assert.throws(() => store.delete(created.id, { uid: 'bob' }), /forbidden/);
  assert.equal(store.delete(created.id, { uid: 'alice' }), true);
  assert.equal(store.get(created.id, { uid: 'alice' }), null);
});

test('search por profile retorna solo libs con ese profile', () => {
  const store = new MemoryStore();
  store.create(parseOrThrow(validRaw({
    name: 'L1',
    claims: [{ id: 'K', formula: '□p', profile: 'K', kind: 'axiom' }]
  })));
  store.create(parseOrThrow(validRaw({
    name: 'L2',
    claims: [{ id: 'EM', formula: 'p∨¬p', profile: 'CL', kind: 'axiom' }]
  })));
  const out = store.list({ profile: 'CL' });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.name, 'L2');
});

test('subscribe añade workspaceId a consumers (idempotente)', () => {
  const store = new MemoryStore();
  const created = store.create(parseOrThrow(validRaw()));

  store.subscribe(created.id, 'ws-99', { uid: 'bob', workspaceId: 'ws-99' });
  store.subscribe(created.id, 'ws-99', { uid: 'bob', workspaceId: 'ws-99' });
  const fetched = store.get(created.id, { uid: 'alice' });
  assert.deepEqual(fetched!.consumers, ['ws-99']);
});

test('subscribe rechaza requester sin acceso a private', () => {
  const store = new MemoryStore();
  const created = store.create(parseOrThrow(validRaw({ visibility: 'private' })));
  assert.throws(
    () => store.subscribe(created.id, 'ws-99', { uid: 'bob', workspaceId: 'ws-99' }),
    /forbidden/
  );
});

test('subscribe permite a un workspace ya en consumers seguir leyendo (workspace visibility)', () => {
  const store = new MemoryStore();
  const input = parseOrThrow(validRaw({
    visibility: 'workspace',
    owner: { uid: 'alice', workspaceId: 'ws-1' }
  }));
  const created = store.create(input);
  // owner suscribe ws-2 manualmente como acto administrativo (público dentro de su org).
  store.subscribe(created.id, 'ws-2', { uid: 'alice' });
  const fetched = store.get(created.id, { uid: 'carol', workspaceId: 'ws-2' });
  assert.ok(fetched, 'workspace consumer debería poder leer');
});
