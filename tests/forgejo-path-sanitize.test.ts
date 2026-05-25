/**
 * BUG: un doc con name="../escape.md" (QA path-traversal) hacía que
 * buildRepoPath devolviera "../escape.md", lo que rompía isIgnoredPath
 * (paquete `ignore` rechaza paths no relativos) y tumbaba git/status con 500.
 *
 * buildRepoPath ahora sanitiza igual que el blob en MinIO: separadores → `_`
 * y segmentos `..`/`.` puros → `_`, devolviendo siempre un path relativo seguro.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRepoPath } from '../src/lib/forgejo-path.ts';

test('buildRepoPath neutraliza path-traversal en name', () => {
  const repoPath = buildRepoPath('', '../escape.md');
  assert.equal(repoPath, '.._escape.md');
  assert.ok(!repoPath.startsWith('/'), 'no debe ser absoluto');
  assert.ok(!repoPath.includes('../'), 'no debe contener `../`');
});

test('buildRepoPath neutraliza escape via folder', () => {
  const repoPath = buildRepoPath('../../etc', 'passwd');
  assert.ok(!repoPath.includes('..'), `folder no debe escapar: ${repoPath}`);
  assert.equal(repoPath, '_/_/etc/passwd');
});

test('buildRepoPath colapsa segmento `..` puro en name a `_`', () => {
  assert.equal(buildRepoPath('docs', '..'), 'docs/_');
});

test('buildRepoPath conserva paths normales intactos', () => {
  assert.equal(buildRepoPath('notas/algebra', 'teorema.md'), 'notas/algebra/teorema.md');
  assert.equal(buildRepoPath('', 'README.md'), 'README.md');
});

test('buildRepoPath usa untitled cuando name vacío', () => {
  assert.equal(buildRepoPath('', ''), 'untitled');
  assert.equal(buildRepoPath('   ', '   '), 'untitled');
});
