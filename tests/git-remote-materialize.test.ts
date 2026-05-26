/**
 * Cubre `planMaterialization`: la lógica que decide qué archivos de un repo
 * clonado se vuelven documentos del workspace y cómo se mapean (folder/name/
 * storagePath/text-vs-binary), incluyendo los caps de import.
 *
 * Es la pieza load-bearing del fix "import GitHub → docs visibles": si el
 * mapping o el skip de `.git/`/binarios se rompe, el user vería basura o nada.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { planMaterialization } from '../src/lib/git-remotes/materialize-docs.ts';

const WS = 'ws-abc';
const UID = 'uid-xyz';

const writeRepo = async (files: Record<string, Buffer | string>): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agora-test-repo-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body);
  }
  return root;
};

const find = (plan: { files: Array<{ relPath: string }> }, rel: string) =>
  plan.files.find((f) => f.relPath.split(path.sep).join('/') === rel);

test('mapea path del repo a folder/name/storagePath del workspace', async () => {
  const root = await writeRepo({
    'README.md': '# Hola',
    'docs/intro.md': 'intro',
    'src/logic/teorema.st': 'P -> Q'
  });
  try {
    const plan = await planMaterialization(root, { workspaceId: WS, ownerUid: UID });
    assert.equal(plan.files.length, 3);

    const readme = find(plan, 'README.md');
    assert.ok(readme);
    assert.equal(readme!.folder, '');
    assert.equal(readme!.fileName, 'README.md');
    assert.equal(readme!.storagePath, `workspaces/${WS}/README.md`);
    assert.equal(readme!.isText, true);

    const intro = find(plan, 'docs/intro.md');
    assert.ok(intro);
    assert.equal(intro!.folder, 'docs');
    assert.equal(intro!.storagePath, `workspaces/${WS}/docs/intro.md`);

    const teorema = find(plan, 'src/logic/teorema.st');
    assert.ok(teorema);
    assert.equal(teorema!.folder, 'src/logic');
    assert.equal(teorema!.storagePath, `workspaces/${WS}/src/logic/teorema.st`);
    assert.equal(teorema!.isText, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('workspace personal usa prefijo users/<uid>/', async () => {
  const root = await writeRepo({ 'a.md': 'x' });
  try {
    const plan = await planMaterialization(root, { workspaceId: 'personal', ownerUid: UID });
    assert.equal(plan.files[0]?.storagePath, `users/${UID}/a.md`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('salta .git/ y node_modules/', async () => {
  const root = await writeRepo({
    'real.md': 'doc',
    '.git/config': '[core]',
    '.git/refs/heads/main': 'abc',
    'node_modules/dep/index.js': 'module.exports={}'
  });
  try {
    const plan = await planMaterialization(root, { workspaceId: WS, ownerUid: UID });
    const rels = plan.files.map((f) => f.relPath.split(path.sep).join('/'));
    assert.deepEqual(rels, ['real.md']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('detecta binario por NUL bytes y le da type file', async () => {
  const root = await writeRepo({
    'img.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]),
    'note.txt': 'plain text'
  });
  try {
    const plan = await planMaterialization(root, { workspaceId: WS, ownerUid: UID });
    const png = find(plan, 'img.png');
    const txt = find(plan, 'note.txt');
    assert.equal(png!.isText, false);
    assert.equal(txt!.isText, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('dotfiles conocidos (.gitignore) van como texto', async () => {
  const root = await writeRepo({ '.gitignore': 'node_modules\n' });
  try {
    const plan = await planMaterialization(root, { workspaceId: WS, ownerUid: UID });
    const gi = find(plan, '.gitignore');
    assert.ok(gi);
    assert.equal(gi!.isText, true);
    assert.equal(gi!.fileName, '.gitignore');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cap por nº de archivos trunca de forma determinista', async () => {
  const root = await writeRepo({
    'a.md': '1', 'b.md': '2', 'c.md': '3', 'd.md': '4'
  });
  try {
    const plan = await planMaterialization(root, { workspaceId: WS, ownerUid: UID, maxFiles: 2 });
    assert.equal(plan.files.length, 2);
    assert.equal(plan.truncated, true);
    // Orden alfabético estable: entran a.md y b.md.
    const rels = plan.files.map((f) => f.relPath.split(path.sep).join('/')).sort();
    assert.deepEqual(rels, ['a.md', 'b.md']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cap por bytes totales trunca y salta archivos sobre el máximo individual', async () => {
  const big = Buffer.alloc(2000, 0x61); // 'a' * 2000
  const root = await writeRepo({
    'small.md': 'tiny',
    'over.md': big
  });
  try {
    // maxFileBytes corta over.md (>1000) y lo cuenta como skipped, no truncated.
    const plan = await planMaterialization(root, {
      workspaceId: WS, ownerUid: UID, maxFileBytes: 1000
    });
    const rels = plan.files.map((f) => f.relPath.split(path.sep).join('/'));
    assert.deepEqual(rels, ['small.md']);
    assert.equal(plan.skipped, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
