import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isDestructiveShellCommand,
  isSafeReadOnlyCommand,
  validateWorkspaceRelPath,
  buildReadCommand,
  buildWriteCommand,
  shellQuote
} from '../src/lib/agora-ai/toolExecutors/worker-shell.ts';

// Bug I-1: el comando construido NUNCA debe contener `cd`. La whitelist del
// worker (agent-command-policy.mjs) bloquea ese binario. Antes el código
// prefijaba con `cd /workspace && ...` y todas las llamadas fallaban con
// `binary "cd" no está en la whitelist`. El worker resuelve cwd a /workspace
// automáticamente cuando cwd === '.'.
test('Bug I-1: buildReadCommand no usa cd', () => {
  const cmd = buildReadCommand('notes/foo.md', 1024);
  assert.equal(cmd.includes(' cd '), false, `read command no debe contener cd: ${cmd}`);
  assert.equal(cmd.startsWith('head '), true);
  assert.ok(cmd.endsWith(`'notes/foo.md'`));
});

test('Bug I-1: buildWriteCommand no usa cd y soporta subdir', () => {
  const cmd = buildWriteCommand('docs/sub/file.md', 'aGVsbG8=');
  assert.equal(cmd.includes(' cd '), false, `write command no debe contener cd: ${cmd}`);
  assert.ok(cmd.includes(`mkdir -p 'docs/sub'`));
  assert.ok(cmd.includes(`> 'docs/sub/file.md'`));
});

test('Bug I-1: buildWriteCommand sin subdir omite mkdir', () => {
  const cmd = buildWriteCommand('root.txt', 'YQ==');
  assert.equal(cmd.startsWith('echo '), true);
  assert.ok(cmd.includes(`> 'root.txt'`));
  assert.equal(cmd.includes('mkdir'), false);
});

test('Bug I-1: validateWorkspaceRelPath rechaza paths inválidos', () => {
  assert.throws(() => validateWorkspaceRelPath(''), /requerido/);
  assert.throws(() => validateWorkspaceRelPath('/etc/passwd'), /relativo/);
  assert.throws(() => validateWorkspaceRelPath('../escape'), /traversal/);
  assert.throws(() => validateWorkspaceRelPath('a/../b'), /traversal/);
  assert.throws(() => validateWorkspaceRelPath('with\0null'), /nulos/);
  assert.equal(validateWorkspaceRelPath('foo.md'), 'foo.md');
  assert.equal(validateWorkspaceRelPath('sub/foo.md'), 'sub/foo.md');
});

// Bug I-3: política de confirmación consistente.
test('Bug I-3: comandos destructivos siempre detectados', () => {
  assert.equal(isDestructiveShellCommand('rm -rf foo'), true);
  assert.equal(isDestructiveShellCommand('dd if=/dev/zero of=foo'), true);
  assert.equal(isDestructiveShellCommand('echo hi > out.txt'), true);
  assert.equal(isDestructiveShellCommand('shred sensitive.log'), true);
  assert.equal(isDestructiveShellCommand('truncate -s 0 db.sqlite'), true);
});

test('Bug I-3: reads seguros NO son destructivos', () => {
  assert.equal(isDestructiveShellCommand('ls -la'), false);
  assert.equal(isDestructiveShellCommand('cat README.md'), false);
  assert.equal(isDestructiveShellCommand('grep -r TODO src/'), false);
  assert.equal(isDestructiveShellCommand('find . -name "*.ts"'), false);
});

test('Bug I-3: isSafeReadOnlyCommand acepta reads puros', () => {
  assert.equal(isSafeReadOnlyCommand('pwd'), true);
  assert.equal(isSafeReadOnlyCommand('ls'), true);
  assert.equal(isSafeReadOnlyCommand('cat README.md | grep Agora | head -5'), true);
  assert.equal(isSafeReadOnlyCommand('find . -name "*.md" | sort'), true);
});

test('Bug I-3: isSafeReadOnlyCommand rechaza escrituras y unknowns', () => {
  assert.equal(isSafeReadOnlyCommand('rm foo'), false);
  assert.equal(isSafeReadOnlyCommand('echo x > out'), false);
  assert.equal(isSafeReadOnlyCommand('npm install'), false); // npm no está en safe-reads
  assert.equal(isSafeReadOnlyCommand('git status'), false);  // git tampoco
  assert.equal(isSafeReadOnlyCommand(''), false);
});

test('shellQuote escapa comillas simples correctamente', () => {
  assert.equal(shellQuote("simple"), `'simple'`);
  assert.equal(shellQuote("with'quote"), `'with'\\''quote'`);
});

// Bug I-1 regression: el comando construido pasa la whitelist del worker.
// Reproducimos validateAgentCommand del worker para garantizar end-to-end
// que un read/write no se va a romper en el cliente real.
// Mirror exacto de agent-command-policy.mjs del worker. Si actualizas la
// whitelist allá, actualiza acá (este test garantiza que los comandos que
// construye el backend pasarán la validación del worker).
const ALLOWED_AGENT_BINARIES = new Set([
  'ls', 'pwd', 'cat', 'echo', 'head', 'tail', 'wc', 'grep', 'find', 'sort', 'uniq',
  'cut', 'awk', 'sed', 'tr', 'tee', 'diff', 'stat', 'file', 'date',
  'mkdir', 'touch', 'cp', 'mv', 'rm', 'ln',
  'base64',
  'git', 'node', 'npm', 'pnpm', 'npx', 'yarn',
  'python', 'python3', 'pip', 'pip3', 'curl', 'wget',
  'tree', 'jq', 'tsc', 'eslint', 'prettier',
  'true', 'false'
]);
const SHELL_EXPANSION_RE = /\$\(|`|<\(|>\(/;
const REDIRECT_OUTSIDE_RE = /[>&]\s*\/(?!workspace|tmp\/agora-tmp)/;

function simulateWorkerWhitelist(cmd: string): { ok: true } | { ok: false; reason: string } {
  if (SHELL_EXPANSION_RE.test(cmd) || REDIRECT_OUTSIDE_RE.test(cmd)) {
    return { ok: false, reason: 'shell expansion' };
  }
  const segments = cmd.split(/(?:\|\||&&|;|\|)/).map((s) => s.trim()).filter(Boolean);
  for (const segment of segments) {
    const tokens = segment.split(/\s+/).filter(Boolean);
    const head = tokens[0];
    if (!head) continue;
    const realHead = /^[A-Z_][A-Z0-9_]*=/.test(head) ? tokens[1] : head;
    if (!realHead) return { ok: false, reason: `empty: ${segment}` };
    const binary = realHead.split('/').pop();
    if (!binary || !ALLOWED_AGENT_BINARIES.has(binary)) {
      return { ok: false, reason: `binary "${binary}" no en whitelist` };
    }
  }
  return { ok: true };
}

test('Bug I-1 regression: buildReadCommand pasa la whitelist del worker', () => {
  const verdict = simulateWorkerWhitelist(buildReadCommand('notes/foo.md', 1024));
  assert.equal(verdict.ok, true, verdict.ok ? '' : verdict.reason);
});

test('Bug I-1 regression: buildWriteCommand pasa la whitelist del worker', () => {
  const verdict = simulateWorkerWhitelist(buildWriteCommand('docs/sub/file.md', 'aGVsbG8='));
  assert.equal(verdict.ok, true, verdict.ok ? '' : verdict.reason);
});

test('Bug I-1 regression: comando con cd FALLA la whitelist (sanity check inverso)', () => {
  const verdict = simulateWorkerWhitelist(`cd /workspace && head -c 100 'foo.md'`);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /binary "cd"/);
});
