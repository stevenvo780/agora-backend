import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCitations, buildBibKeyIndex, type WorkspaceDocRef } from '../src/lib/citations/parser.ts';

const buildDocs = (entries: WorkspaceDocRef[]): Map<string, WorkspaceDocRef> => {
  const map = new Map<string, WorkspaceDocRef>();
  for (const entry of entries) map.set(entry.id, entry);
  return map;
};

test('parseCitations: detects wiki-link by exact name', () => {
  const docs = buildDocs([
    { id: 'a', name: 'Nota A' },
    { id: 'b', name: 'Nota B' }
  ]);
  const edges = parseCitations('Texto con [[Nota B]] dentro.', docs, { selfDocId: 'a' });
  assert.equal(edges.length, 1);
  assert.equal(edges[0]?.targetDocId, 'b');
  assert.equal(edges[0]?.kind, 'wiki');
  assert.equal(edges[0]?.weight, 1);
});

test('parseCitations: wiki alias [[doc|alias]] resuelve por target real', () => {
  const docs = buildDocs([
    { id: 'a', name: 'Nota A' },
    { id: 'b', name: 'Nota B' }
  ]);
  const edges = parseCitations('Ver [[Nota B|esta otra nota]] aquí.', docs, { selfDocId: 'a' });
  assert.equal(edges.length, 1);
  assert.equal(edges[0]?.targetDocId, 'b');
});

test('parseCitations: detects markdown link to .md doc', () => {
  const docs = buildDocs([
    { id: 'a', name: 'Origen' },
    { id: 'b', name: 'destino.md' }
  ]);
  const edges = parseCitations('Mira [aquí](destino.md) más info.', docs, { selfDocId: 'a' });
  assert.equal(edges.length, 1);
  assert.equal(edges[0]?.targetDocId, 'b');
  assert.equal(edges[0]?.kind, 'link');
});

test('parseCitations: external URLs y anchors se ignoran', () => {
  const docs = buildDocs([
    { id: 'a', name: 'Origen' }
  ]);
  const edges = parseCitations(
    'Externo [google](https://google.com) y [seccion](#seccion-x) y [mailto](mailto:a@b.com).',
    docs,
    { selfDocId: 'a' }
  );
  assert.equal(edges.length, 0);
});

test('parseCitations: link a doc inexistente se ignora', () => {
  const docs = buildDocs([
    { id: 'a', name: 'Origen' },
    { id: 'b', name: 'B' }
  ]);
  const edges = parseCitations('Esto cita [a](no-existe.md) y [b](B).', docs, { selfDocId: 'a' });
  assert.equal(edges.length, 1);
  assert.equal(edges[0]?.targetDocId, 'b');
});

test('parseCitations: relative path con prefijo ./ funciona', () => {
  const docs = buildDocs([
    { id: 'a', name: 'Origen' },
    { id: 'b', name: 'destino.md' }
  ]);
  const edges = parseCitations('Ver [x](./destino.md).', docs, { selfDocId: 'a' });
  assert.equal(edges.length, 1);
  assert.equal(edges[0]?.targetDocId, 'b');
});

test('parseCitations: NFD/diacritics normalizados', () => {
  const docs = buildDocs([
    { id: 'a', name: 'Origen' },
    { id: 'b', name: 'Filosofía clásica' }
  ]);
  const edges = parseCitations('Cita [[filosofia clasica]] aquí.', docs, { selfDocId: 'a' });
  assert.equal(edges.length, 1);
  assert.equal(edges[0]?.targetDocId, 'b');
});

test('parseCitations: dedup + weight cuenta ocurrencias', () => {
  const docs = buildDocs([
    { id: 'a', name: 'Origen' },
    { id: 'b', name: 'Nota B' }
  ]);
  const edges = parseCitations('Primera [[Nota B]]. Segunda [[Nota B]]. Tercera [[Nota B]].', docs, { selfDocId: 'a' });
  assert.equal(edges.length, 1);
  assert.equal(edges[0]?.weight, 3);
});

test('parseCitations: autocita se descarta', () => {
  const docs = buildDocs([
    { id: 'a', name: 'Nota A' },
    { id: 'b', name: 'Nota B' }
  ]);
  const edges = parseCitations('Yo soy [[Nota A]] y cito [[Nota B]].', docs, { selfDocId: 'a' });
  assert.equal(edges.length, 1);
  assert.equal(edges[0]?.targetDocId, 'b');
});

test('parseCitations: bib citation resuelve via bibKeyIndex', () => {
  const docs = buildDocs([
    { id: 'a', name: 'Origen' },
    { id: 'searle', name: 'Searle2010.pdf' }
  ]);
  const bibIndex = buildBibKeyIndex(docs.values());
  assert.equal(bibIndex.get('Searle2010'), 'searle');
  const edges = parseCitations('Ver [@Searle2010, p. 23] sobre intencionalidad.', docs, {
    selfDocId: 'a',
    bibKeyIndex: bibIndex
  });
  assert.equal(edges.length, 1);
  assert.equal(edges[0]?.targetDocId, 'searle');
  assert.equal(edges[0]?.kind, 'bib');
});

test('parseCitations: posición calculada en línea/col correctos', () => {
  const docs = buildDocs([
    { id: 'a', name: 'Origen' },
    { id: 'b', name: 'Nota B' }
  ]);
  const content = 'Linea 1.\nLinea 2 con [[Nota B]] dentro.';
  const edges = parseCitations(content, docs, { selfDocId: 'a' });
  assert.equal(edges.length, 1);
  assert.equal(edges[0]?.position?.line, 2);
  assert.ok((edges[0]?.position?.col ?? 0) > 1);
});

test('parseCitations: contenido vacío no rompe', () => {
  const docs = buildDocs([{ id: 'a', name: 'Origen' }]);
  assert.deepEqual(parseCitations('', docs, { selfDocId: 'a' }), []);
  assert.deepEqual(parseCitations(null as unknown as string, docs, { selfDocId: 'a' }), []);
});

test('parseCitations: match por base name sin extensión', () => {
  const docs = buildDocs([
    { id: 'a', name: 'Origen' },
    { id: 'b', name: 'destino.md' }
  ]);
  const edges = parseCitations('Texto [[destino]] cita.', docs, { selfDocId: 'a' });
  assert.equal(edges.length, 1);
  assert.equal(edges[0]?.targetDocId, 'b');
});

test('parseCitations: match por storagePath basename', () => {
  const docs = buildDocs([
    { id: 'a', name: 'Origen' },
    { id: 'b', name: 'Doc B', storagePath: 'workspaces/x/y/destino-archivo.md' }
  ]);
  const edges = parseCitations('Cita [x](destino-archivo.md).', docs, { selfDocId: 'a' });
  assert.equal(edges.length, 1);
  assert.equal(edges[0]?.targetDocId, 'b');
});
