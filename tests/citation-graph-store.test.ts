/**
 * Bug: GET /api/workspaces/:id/citation-graph devolvía `edges=0` cuando el
 * caller no pasaba `focus` (modo workspace-wide) y el workspace tenía más
 * de 500 docs. El route handler usa `focusDocIds = Array.from(metaIndex.keys())`,
 * el BFS empujaba los 500 primeros como nodos focales y el cap cortaba
 * ANTES de leer ninguna cita.
 *
 * Cubre los helpers puros que sostienen el fix sin tocar firebase-admin
 * (la integración Firestore se valida con smoke contra el deploy):
 *   - shouldUseWorkspaceWideScan: cuándo cambiar de BFS a single scan.
 *   - rankNodesForCap: focos primero, luego mayor grado, al podar.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldUseWorkspaceWideScan,
  rankNodesForCap,
  CITATION_GRAPH_HARD_CAPS
} from '../src/lib/citations/graph-store.ts';

test('shouldUseWorkspaceWideScan: focus pequeño usa BFS', () => {
  assert.equal(shouldUseWorkspaceWideScan(1, 500), false);
  assert.equal(shouldUseWorkspaceWideScan(10, 500), false);
  assert.equal(shouldUseWorkspaceWideScan(250, 500), false);
});

test('shouldUseWorkspaceWideScan: focus > maxNodes/2 dispara scan workspace-wide', () => {
  // Regresión del bug: 501 focos en cap 500 antes daba edges=0 con BFS;
  // ahora pasa al scan.
  assert.equal(shouldUseWorkspaceWideScan(251, 500), true);
  assert.equal(shouldUseWorkspaceWideScan(501, 500), true);
  assert.equal(shouldUseWorkspaceWideScan(5000, 500), true);
});

test('shouldUseWorkspaceWideScan: usa el cap hard real por defecto', () => {
  const cap = CITATION_GRAPH_HARD_CAPS.maxNodes;
  assert.equal(shouldUseWorkspaceWideScan(Math.floor(cap / 2), cap), false);
  assert.equal(shouldUseWorkspaceWideScan(Math.floor(cap / 2) + 1, cap), true);
});

test('shouldUseWorkspaceWideScan: maxNodes=1 evita división por cero', () => {
  // Math.floor(1/2)=0 → Math.max(1,0)=1, así que necesita focusCount>1.
  assert.equal(shouldUseWorkspaceWideScan(1, 1), false);
  assert.equal(shouldUseWorkspaceWideScan(2, 1), true);
});

test('rankNodesForCap: focos siempre primero, luego mayor grado', () => {
  const focusSet = new Set<string>(['a', 'b']);
  const degree = new Map<string, number>([
    ['a', 1],
    ['b', 2],
    ['c', 10],
    ['d', 5]
  ]);
  const ranked = rankNodesForCap(['c', 'a', 'd', 'b'], focusSet, degree);
  // focos primero (b antes que a porque b tiene más grado), luego c (10), luego d (5)
  assert.deepEqual(ranked, ['b', 'a', 'c', 'd']);
});

test('rankNodesForCap: empate de grado mantiene orden estable', () => {
  const focusSet = new Set<string>();
  const degree = new Map<string, number>([
    ['x', 5],
    ['y', 5],
    ['z', 5]
  ]);
  const ranked = rankNodesForCap(['x', 'y', 'z'], focusSet, degree);
  assert.equal(ranked.length, 3);
  assert.ok(ranked.includes('x') && ranked.includes('y') && ranked.includes('z'));
});

test('rankNodesForCap: nodos sin entry en degree se tratan como grado 0', () => {
  const focusSet = new Set<string>();
  const degree = new Map<string, number>([['known', 3]]);
  const ranked = rankNodesForCap(['unknown', 'known'], focusSet, degree);
  assert.deepEqual(ranked, ['known', 'unknown']);
});
