import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLibraryCreateInput,
  parseLibraryUpdatePatch
} from '../../../src/lib/cloud-libraries/index.ts';

const validInput = () => ({
  name: 'Lógica modal básica',
  description: 'Axiomas K, T, S4, S5',
  owner: { uid: 'alice', workspaceId: 'ws-1' },
  visibility: 'public',
  version: '1.0.0',
  claims: [
    { id: 'K', formula: '□(p→q) → (□p→□q)', profile: 'K', kind: 'axiom', tags: ['modal'] },
    { id: 'T', formula: '□p → p', profile: 'T', kind: 'axiom' }
  ]
});

test('parseLibraryCreateInput: input válido retorna ok', () => {
  const result = parseLibraryCreateInput(validInput());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.name, 'Lógica modal básica');
    assert.equal(result.value.claims.length, 2);
    assert.equal(result.value.owner.uid, 'alice');
    assert.equal(result.value.version, '1.0.0');
  }
});

test('parseLibraryCreateInput: visibility inválida falla', () => {
  const input = { ...validInput(), visibility: 'open' };
  const result = parseLibraryCreateInput(input);
  assert.equal(result.ok, false);
});

test('parseLibraryCreateInput: kind inválido falla', () => {
  const input = validInput();
  input.claims[0]!.kind = 'lemma' as 'axiom';
  const result = parseLibraryCreateInput(input);
  assert.equal(result.ok, false);
});

test('parseLibraryCreateInput: claim id duplicado falla', () => {
  const input = validInput();
  input.claims[1]!.id = 'K';
  const result = parseLibraryCreateInput(input);
  assert.equal(result.ok, false);
});

test('parseLibraryCreateInput: version no-semver falla', () => {
  const input = { ...validInput(), version: 'v1' };
  const result = parseLibraryCreateInput(input);
  assert.equal(result.ok, false);
});

test('parseLibraryCreateInput: owner.uid faltante falla', () => {
  const input = { ...validInput(), owner: {} };
  const result = parseLibraryCreateInput(input);
  assert.equal(result.ok, false);
});

test('parseLibraryUpdatePatch: patch vacío falla', () => {
  const result = parseLibraryUpdatePatch({});
  assert.equal(result.ok, false);
});

test('parseLibraryUpdatePatch: parche parcial válido', () => {
  const result = parseLibraryUpdatePatch({ name: 'Nuevo nombre' });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.name, 'Nuevo nombre');
    assert.equal(result.value.description, undefined);
  }
});

test('parseLibraryUpdatePatch: visibility válida actualiza', () => {
  const result = parseLibraryUpdatePatch({ visibility: 'workspace' });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.visibility, 'workspace');
});

test('parseLibraryUpdatePatch: claims con id duplicado falla', () => {
  const result = parseLibraryUpdatePatch({
    claims: [
      { id: 'A', formula: 'p', profile: 'CL', kind: 'axiom' },
      { id: 'A', formula: 'q', profile: 'CL', kind: 'axiom' }
    ]
  });
  assert.equal(result.ok, false);
});
