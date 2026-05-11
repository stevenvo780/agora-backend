/**
 * Bug 19: GET /api/workspaces/:id/citation-graph?depth=2 devolvía 400
 *         porque el handler exigía `focus` siempre. El front llama sin
 *         focus para pedir el subgrafo workspace-wide.
 *
 * Cubre:
 *   - parseDepth clampa al rango [1, 3] y default 1.
 *   - parseFocus tolera CSV vacío / espacios y devuelve [].
 *   - parseKinds filtra valores no-CitationKind.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDepth,
  parseFocus,
  parseKinds
} from '../src/app/api/workspaces/[id]/citation-graph/route.ts';

test('parseDepth: default 1 cuando no hay query param', () => {
  assert.equal(parseDepth(null), 1);
  assert.equal(parseDepth(''), 1);
});

test('parseDepth: clampa al rango [1, 3]', () => {
  assert.equal(parseDepth('0'), 1);
  assert.equal(parseDepth('1'), 1);
  assert.equal(parseDepth('2'), 2);
  assert.equal(parseDepth('3'), 3);
  assert.equal(parseDepth('99'), 3);
  assert.equal(parseDepth('-5'), 1);
});

test('parseDepth: valores no numéricos caen al default', () => {
  assert.equal(parseDepth('abc'), 1);
  assert.equal(parseDepth('NaN'), 1);
});

test('parseFocus: vacío o ausente devuelve [] (workspace-wide)', () => {
  assert.deepEqual(parseFocus(null), []);
  assert.deepEqual(parseFocus(''), []);
  assert.deepEqual(parseFocus(' , , '), []);
});

test('parseFocus: CSV con espacios se normaliza', () => {
  assert.deepEqual(parseFocus('doc-1, doc-2 ,doc-3'), ['doc-1', 'doc-2', 'doc-3']);
});

test('parseKinds: undefined cuando no hay raw o ningún kind válido', () => {
  assert.equal(parseKinds(null), undefined);
  assert.equal(parseKinds(''), undefined);
  assert.equal(parseKinds('foo,bar'), undefined);
});

test('parseKinds: filtra los CitationKind válidos', () => {
  assert.deepEqual(parseKinds('wiki,link'), ['wiki', 'link']);
  assert.deepEqual(parseKinds('wiki, foo ,bib'), ['wiki', 'bib']);
});
