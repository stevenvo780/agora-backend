/**
 * Tests de applyCommit() — verifica que un commit lógico produce
 * exactamente 1 POST a Forgejo /contents (sin chunking).
 *
 * forgejo-git.ts lee FORGEJO_API_URL y FORGEJO_ADMIN_TOKEN al import,
 * así que seteamos esas env vars antes de importar el módulo y mockeamos
 * globalThis.fetch para capturar las requests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FORGEJO_API_URL = 'https://forgejo.test.local';
process.env.FORGEJO_ADMIN_TOKEN = 'test-token';

const { applyCommit } = await import('../src/lib/forgejo-git.ts');
type ProgressEvent = Parameters<NonNullable<Parameters<typeof applyCommit>[0]['onProgress']>>[0];

interface FetchCall {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
}

const installFetchMock = (responder: (call: FetchCall) => { status: number; body: unknown }): { calls: FetchCall[]; restore: () => void } => {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const h = init?.headers as Record<string, string> | undefined;
    if (h) for (const [k, v] of Object.entries(h)) headers[k] = String(v);
    const call: FetchCall = {
      url: typeof url === 'string' ? url : url.toString(),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : '',
      headers
    };
    calls.push(call);
    const res = responder(call);
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
};

const okResponse = (sha: string) => ({
  status: 201,
  body: {
    commit: {
      sha,
      url: `https://forgejo.test.local/api/v1/repos/agora/test/git/commits/${sha}`,
      html_url: `https://forgejo.test.local/agora/test/commit/${sha}`,
      message: 'test',
      author: { name: 'test', email: 't@x', date: '2026-01-01T00:00:00Z' },
      committer: { name: 'test', email: 't@x', date: '2026-01-01T00:00:00Z' }
    },
    files: []
  }
});

test('applyCommit envía un solo POST sin importar la cantidad de archivos', async () => {
  const { calls, restore } = installFetchMock(() => okResponse('abc123'));
  try {
    const changes = Array.from({ length: 25 }, (_, i) => ({
      path: `file_${i}.txt`,
      operation: 'create' as const,
      content: Buffer.from(`hello ${i}`)
    }));
    const res = await applyCommit({
      repoFullName: 'agora/test',
      message: 'commit logico',
      changes
    });
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1, 'debe haber exactamente 1 POST');
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.method, 'POST');
    assert.match(call.url, /\/api\/v1\/repos\/agora\/test\/contents$/);
    const body = JSON.parse(call.body) as { files: unknown[]; message: string };
    assert.equal(body.files.length, 25);
  } finally { restore(); }
});

test('applyCommit no agrega "(parte i/N)" al mensaje', async () => {
  const { calls, restore } = installFetchMock(() => okResponse('abc'));
  try {
    const changes = Array.from({ length: 50 }, (_, i) => ({
      path: `f${i}.txt`,
      operation: 'create' as const,
      content: Buffer.alloc(100)
    }));
    await applyCommit({
      repoFullName: 'agora/test',
      message: 'mensaje del usuario',
      changes
    });
    const call = calls[0];
    assert.ok(call);
    const body = JSON.parse(call.body) as { message: string };
    assert.equal(body.message, 'mensaje del usuario');
    assert.doesNotMatch(body.message, /parte \d+\/\d+/);
  } finally { restore(); }
});

test('applyCommit devuelve newSha del commit creado', async () => {
  const { restore } = installFetchMock(() => okResponse('deadbeef1234'));
  try {
    const res = await applyCommit({
      repoFullName: 'agora/test',
      message: 'x',
      changes: [{ path: 'a.txt', operation: 'create', content: Buffer.from('x') }]
    });
    assert.equal(res.ok, true);
    assert.equal(res.newSha, 'deadbeef1234');
    assert.deepEqual(res.errors, []);
  } finally { restore(); }
});

test('applyCommit reporta TODOS los paths como fallidos cuando el POST falla', async () => {
  // 422 NO se reintenta (no es 5xx ni 408/425/429), así que devuelve directo.
  const { calls, restore } = installFetchMock(() => ({
    status: 422,
    body: { message: 'sha mismatch' }
  }));
  try {
    const changes = [
      { path: 'a.txt', operation: 'create' as const, content: Buffer.from('a') },
      { path: 'b.txt', operation: 'update' as const, content: Buffer.from('b'), shaIfUpdate: 'old' },
      { path: 'c.txt', operation: 'delete' as const, shaIfDelete: 'old2' }
    ];
    const res = await applyCommit({
      repoFullName: 'agora/test',
      message: 'x',
      changes
    });
    assert.equal(res.ok, false);
    assert.equal(res.errors.length, 3, 'all-or-nothing: todos los paths reportados');
    assert.deepEqual(
      new Set(res.errors.map((e) => e.path)),
      new Set(['a.txt', 'b.txt', 'c.txt'])
    );
    assert.ok(res.errors.every((e) => e.status === 422));
    assert.equal(calls.length, 1);
  } finally { restore(); }
});

test('applyCommit construye el body con operation/sha/content correctos', async () => {
  const { calls, restore } = installFetchMock(() => okResponse('z'));
  try {
    await applyCommit({
      repoFullName: 'agora/test',
      message: 'mix',
      changes: [
        { path: 'create.txt', operation: 'create', content: Buffer.from('new') },
        { path: 'upd.txt', operation: 'update', content: Buffer.from('mod'), shaIfUpdate: 'sha-upd' },
        { path: 'del.txt', operation: 'delete', shaIfDelete: 'sha-del' }
      ]
    });
    const call = calls[0];
    assert.ok(call);
    const body = JSON.parse(call.body) as {
      files: Array<{ path: string; operation: string; content?: string; sha?: string }>;
    };
    const byPath = new Map(body.files.map((f) => [f.path, f]));

    const c = byPath.get('create.txt');
    assert.ok(c);
    assert.equal(c.operation, 'create');
    assert.equal(c.content, Buffer.from('new').toString('base64'));
    assert.equal(c.sha, undefined);

    const u = byPath.get('upd.txt');
    assert.ok(u);
    assert.equal(u.operation, 'update');
    assert.equal(u.content, Buffer.from('mod').toString('base64'));
    assert.equal(u.sha, 'sha-upd');

    const d = byPath.get('del.txt');
    assert.ok(d);
    assert.equal(d.operation, 'delete');
    assert.equal(d.content, undefined);
    assert.equal(d.sha, 'sha-del');
  } finally { restore(); }
});

test('applyCommit reintenta en 5xx y eventualmente acepta', async () => {
  let attempt = 0;
  const { calls, restore } = installFetchMock(() => {
    attempt++;
    if (attempt < 3) return { status: 503, body: { message: 'temporal' } };
    return okResponse('after-retries');
  });
  try {
    const events: ProgressEvent[] = [];
    const res = await applyCommit({
      repoFullName: 'agora/test',
      message: 'x',
      changes: [{ path: 'a.txt', operation: 'create', content: Buffer.from('x') }],
      maxAttempts: 5,
      onProgress: (ev) => events.push(ev)
    });
    assert.equal(res.ok, true, `expected ok, got errors=${JSON.stringify(res.errors)}`);
    assert.equal(res.newSha, 'after-retries');
    assert.equal(calls.length, 3, 'debe reintentar 3 veces');
    const retryEvents = events.filter((e) => e.kind === 'retry');
    assert.equal(retryEvents.length, 2, 'debe emitir 2 eventos retry (entre 3 intentos)');
    const doneEvents = events.filter((e) => e.kind === 'done');
    assert.equal(doneEvents.length, 1);
  } finally { restore(); }
}, { timeout: 30_000 });

test('applyCommit emite onProgress en orden start → attempt → done', async () => {
  const { restore } = installFetchMock(() => okResponse('aabb'));
  try {
    const events: ProgressEvent[] = [];
    await applyCommit({
      repoFullName: 'agora/test',
      message: 'x',
      changes: [{ path: 'a.txt', operation: 'create', content: Buffer.from('x') }],
      onProgress: (ev) => events.push(ev)
    });
    const kinds = events.map((e) => e.kind);
    assert.deepEqual(kinds, ['start', 'attempt', 'done']);
    const start = events[0];
    assert.ok(start && start.kind === 'start');
    assert.equal(start.totalFiles, 1);
  } finally { restore(); }
});
