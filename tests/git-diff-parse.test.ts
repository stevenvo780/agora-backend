import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff } from '../src/lib/forgejo-history.ts';

const SAMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index abc123..def456 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,4 +1,4 @@
 line uno
-line vieja
+line nueva
 line tres
 line cuatro
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+nuevo contenido
+segunda
+tercera
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 1234567..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-borrar 1
-borrar 2
diff --git a/src/from.ts b/src/to.ts
similarity index 90%
rename from src/from.ts
rename to src/to.ts
index 111..222 100644
--- a/src/from.ts
+++ b/src/to.ts
@@ -1,3 +1,3 @@
 igual
-vieja
+nueva
 fin
`;

test('parseUnifiedDiff detecta archivos modificados con additions/deletions', () => {
  const { files } = parseUnifiedDiff(SAMPLE_DIFF);
  assert.equal(files.length, 4);
  const foo = files.find((f) => f.path === 'src/foo.ts');
  assert.ok(foo);
  assert.equal(foo!.status, 'modified');
  assert.equal(foo!.additions, 1);
  assert.equal(foo!.deletions, 1);
});

test('parseUnifiedDiff detecta archivos nuevos', () => {
  const { files } = parseUnifiedDiff(SAMPLE_DIFF);
  const nf = files.find((f) => f.path === 'src/new.ts');
  assert.ok(nf);
  assert.equal(nf!.status, 'added');
  assert.equal(nf!.additions, 3);
  assert.equal(nf!.deletions, 0);
});

test('parseUnifiedDiff detecta archivos borrados', () => {
  const { files } = parseUnifiedDiff(SAMPLE_DIFF);
  const del = files.find((f) => f.path === 'src/old.ts');
  assert.ok(del);
  assert.equal(del!.status, 'removed');
  assert.equal(del!.additions, 0);
  assert.equal(del!.deletions, 2);
});

test('parseUnifiedDiff detecta renombres con oldPath', () => {
  const { files } = parseUnifiedDiff(SAMPLE_DIFF);
  const ren = files.find((f) => f.path === 'src/to.ts');
  assert.ok(ren);
  assert.equal(ren!.status, 'renamed');
  assert.equal(ren!.oldPath, 'src/from.ts');
});

test('parseUnifiedDiff sobre input vacío', () => {
  const { files, truncated } = parseUnifiedDiff('');
  assert.equal(files.length, 0);
  assert.equal(truncated, false);
});

test('parseUnifiedDiff trunca patches gigantes', () => {
  const huge = 'diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n@@ -1,1 +1,1 @@\n' +
    '-' + 'x'.repeat(2 * 1024 * 1024) + '\n' +
    '+' + 'y'.repeat(2 * 1024 * 1024) + '\n';
  const { files, truncated } = parseUnifiedDiff(huge);
  assert.equal(files.length, 1);
  assert.equal(truncated, true);
  assert.ok(files[0]!.patch.includes('[... truncated ...]'));
  assert.ok(files[0]!.patch.length <= 1024 * 1024 + 100);
});
