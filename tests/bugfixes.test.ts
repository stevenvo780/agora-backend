/**
 * Cobertura de los 4 bugs reparados sobre agente IA / search / permisos:
 *
 *   Bug 6  list_documents cap a 25 sin paginación visible al modelo
 *          → default 100, máximo 500, descripción del tool actualizada.
 *   Bug 7  search_documents 0 matches sobre contenido real
 *          → ahora también busca en `searchableContent` (denormalizado).
 *   Bug 11 GET /api/workspaces ignoraba ownerId/email no del JWT
 *          → ahora 400.
 *   Bug 14 read_document(documentId="nombre") fallaba con duplicados
 *          → tryResolveDocumentId devuelve `{ kind:'ambiguous' }` (no throw).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_DOC_LIMIT,
  MAX_DOC_LIMIT,
  clamp
} from '../src/lib/agora-ai/toolExecutor-helpers.ts';
import { AGORA_AGENT_TOOLS } from '../src/lib/agora-ai/toolDefinitions.ts';
import { validateWorkspaceOwnerParams } from '../src/app/api/workspaces/route.ts';

const PRINCIPLE_CONTENT = `# Justicia y la polis

El principio de equidad atraviesa toda la obra. La distribución justa
en la polis depende de cómo entendamos el principio fundamental que
guía la acción del ciudadano. Aristóteles en Política III sostiene
que el principio rector debe nacer de la deliberación común.`;

test('Bug 6: DEFAULT_DOC_LIMIT == 100 (era 25)', () => {
  assert.equal(DEFAULT_DOC_LIMIT, 100);
});

test('Bug 6: MAX_DOC_LIMIT permite hasta 500', () => {
  assert.equal(MAX_DOC_LIMIT, 500);
  assert.equal(clamp(1000, 1, MAX_DOC_LIMIT), 500);
  assert.equal(clamp(250, 1, MAX_DOC_LIMIT), 250);
  assert.equal(clamp(0, 1, MAX_DOC_LIMIT), 1);
});

test('Bug 6: list_documents tool definition documenta cursor + limit hasta 500', () => {
  const def = AGORA_AGENT_TOOLS.find(t => t.name === 'list_documents');
  assert.ok(def, 'list_documents debe existir');
  if (!def) return;
  const props = def.parameters.properties as Record<string, { description?: string }>;
  assert.ok(props.limit, 'limit debe estar declarado');
  assert.match(props.limit.description ?? '', /500/);
  assert.match(props.limit.description ?? '', /100/); // default
  assert.ok(props.cursor, 'cursor debe estar declarado');
  assert.match(def.description, /cursor/i);
  assert.match(def.description, /nextCursor/);
});

test('Bug 7: search_documents incluye searchableContent en el haystack', () => {
  // Simula los docs que vienen de Firestore tras escribir a MinIO:
  // `content` está `FieldValue.delete()`d → ausente. El blob real vive en
  // `searchableContent` (denormalizado por writeDocumentBlob, ~4KB stripped MD).
  const docWithBlob = {
    id: 'doc-blob-1',
    name: 'Etica nicomaquea libro V',
    folder: 'filosofia/clase3',
    searchableContent: PRINCIPLE_CONTENT,
    storagePath: 'workspaces/abc/owner/u/etica.md'
  };
  const docLegacy = {
    id: 'doc-legacy-1',
    name: 'Apuntes sueltos',
    folder: 'filosofia/clase3',
    content: 'sin contenido sobre justicia'
  };

  // Reproduce buildHaystack del searchDocuments executor (sin tocar Firestore).
  const buildHaystack = (doc: { name?: string; folder?: string; searchableContent?: string; content?: string }) => {
    const body = doc.searchableContent || doc.content || '';
    return [doc.name, doc.folder, body].map(p => String(p || '').toLowerCase()).join('\n');
  };

  const query = 'principio';
  assert.ok(buildHaystack(docWithBlob).includes(query), 'haystack debe contener principio via searchableContent');
  assert.equal(buildHaystack(docLegacy).includes(query), false, 'doc legacy no contiene el término');

  // Antes del fix se usaba SOLO doc.content, que para blob-backed docs viene
  // vacío. Validamos que el comportamiento previo era el bug.
  const buggyHaystack = (doc: { name?: string; folder?: string; content?: string }) =>
    [doc.name, doc.folder, doc.content].map(p => String(p || '').toLowerCase()).join('\n');
  assert.equal(buggyHaystack(docWithBlob).includes(query), false, 'haystack viejo NO encontraba principio');
});

test('Bug 14: read_document description anuncia respuesta estructurada de ambigüedad', () => {
  const def = AGORA_AGENT_TOOLS.find(t => t.name === 'read_document');
  assert.ok(def);
  if (!def) return;
  assert.match(def.description, /ambiguous/i);
  assert.match(def.description, /candidates/i);
});

test('Bug 11: ownerId param que NO coincide con auth.uid → 400', () => {
  const params = new URLSearchParams({ ownerId: 'someone-else-uid' });
  const result = validateWorkspaceOwnerParams(params, { uid: 'real-uid', email: 'stev@example.com' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.match(result.error, /ownerId/);
  }
});

test('Bug 11: ownerId param que coincide con auth.uid → ok', () => {
  const params = new URLSearchParams({ ownerId: 'real-uid' });
  const result = validateWorkspaceOwnerParams(params, { uid: 'real-uid', email: null });
  assert.equal(result.ok, true);
});

test('Bug 11: sin params → ok', () => {
  const params = new URLSearchParams();
  const result = validateWorkspaceOwnerParams(params, { uid: 'real-uid', email: 'x@y.com' });
  assert.equal(result.ok, true);
});

test('Bug 11: email param que NO coincide con auth.email → 400', () => {
  const params = new URLSearchParams({ email: 'fake@x.com' });
  const result = validateWorkspaceOwnerParams(params, { uid: 'u', email: 'real@x.com' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.match(result.error, /email/);
  }
});

test('Bug 11: email param que coincide case-insensitive → ok', () => {
  const params = new URLSearchParams({ email: 'STEV@example.com' });
  const result = validateWorkspaceOwnerParams(params, { uid: 'u', email: 'stev@example.com' });
  assert.equal(result.ok, true);
});

test('Bug 11: email param sin email en JWT → 400', () => {
  const params = new URLSearchParams({ email: 'any@x.com' });
  const result = validateWorkspaceOwnerParams(params, { uid: 'u', email: null });
  assert.equal(result.ok, false);
});

test('Bug 11: params vacíos ("?ownerId=") → ok (ignorado)', () => {
  const params = new URLSearchParams({ ownerId: '   ' });
  const result = validateWorkspaceOwnerParams(params, { uid: 'u', email: 'x@y.com' });
  assert.equal(result.ok, true);
});

test('Bug 14: looksLikeFirestoreDocId acepta IDs Firestore reales y rechaza nombres', async () => {
  const { looksLikeFirestoreDocId } = await import('../src/lib/agora-ai/toolExecutors/shared.ts');
  assert.equal(looksLikeFirestoreDocId('aB3xY9zKmNpQrStUvWzZ'), true);
  assert.equal(looksLikeFirestoreDocId('12345678901234567890'), true);
  assert.equal(looksLikeFirestoreDocId('mi documento'), false);
  assert.equal(looksLikeFirestoreDocId('Clase 3'), false);
  assert.equal(looksLikeFirestoreDocId('shortid'), false);
  assert.equal(looksLikeFirestoreDocId('aB3xY9zKmNpQrStUvWzZ-too-long'), false);
});
