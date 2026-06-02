import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBoundedWorkspaceClaim,
  claimsByteLength,
  CLAIMS_BYTE_LIMIT
} from '../src/lib/workspace-claims-bounds';

const wsIds = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `workspace_${String(i).padStart(4, '0')}_abcdef0123456789`);

test('user con muchos ws: el shape viejo supera 1000B (repro del bug)', () => {
  const ids = wsIds(60);
  const oldShape = { workspaces: Object.fromEntries(ids.map((id) => [id, true])) };
  assert.ok(
    claimsByteLength(oldShape) > CLAIMS_BYTE_LIMIT,
    'el payload con todos los ws debe exceder 1000B para reproducir el fallo histórico'
  );
});

test('user con muchos ws: el claim resultante queda <1000B y es un map válido', () => {
  const ids = wsIds(60);
  const { claims, included, dropped } = buildBoundedWorkspaceClaim({ role: 'student' }, ids);

  assert.ok(claimsByteLength(claims) <= CLAIMS_BYTE_LIMIT, 'el claim debe caber en 1000B');

  const workspaces = (claims as { workspaces: Record<string, boolean> }).workspaces;
  for (const id of included) {
    assert.equal(workspaces[id], true, `el ws incluido ${id} debe ser true en el map`);
  }
  for (const id of dropped) {
    assert.equal(id in workspaces, false, `el ws dropeado ${id} no debe aparecer (fail-closed)`);
  }

  assert.equal((claims as { role: string }).role, 'student', 'claims base (role) preservados');
  assert.ok(included.length > 0, 'debe incluir al menos algunos ws');
  assert.ok(dropped.length > 0, 'con 60 ws grandes debe haber dropeados');
});

test('truncado determinista: misma entrada, misma salida', () => {
  const ids = wsIds(60);
  const a = buildBoundedWorkspaceClaim({ role: 'student' }, ids);
  const b = buildBoundedWorkspaceClaim({ role: 'student' }, [...ids].reverse());
  assert.deepEqual(a.included, b.included);
  assert.deepEqual(a.dropped, b.dropped);
});

test('user con pocos ws: claim completo, nada dropeado', () => {
  const ids = wsIds(3);
  const { claims, included, dropped } = buildBoundedWorkspaceClaim({ role: 'teacher' }, ids);

  assert.equal(dropped.length, 0, 'pocos ws no deben dropearse');
  assert.deepEqual(included.sort(), [...ids].sort());

  const workspaces = (claims as { workspaces: Record<string, boolean> }).workspaces;
  for (const id of ids) assert.equal(workspaces[id], true);
  assert.ok(claimsByteLength(claims) <= CLAIMS_BYTE_LIMIT);
});

test('claims base siempre se preservan aunque la lista sea enorme', () => {
  const ids = wsIds(500);
  const base = { role: 'admin', workspaceId: 'sync-agent-ws-id-xyz' };
  const { claims } = buildBoundedWorkspaceClaim(base, ids);

  assert.equal((claims as { role: string }).role, 'admin');
  assert.equal((claims as { workspaceId: string }).workspaceId, 'sync-agent-ws-id-xyz');
  assert.ok(claimsByteLength(claims) <= CLAIMS_BYTE_LIMIT);
});

test('sin ws: claim con map vacío, base intacto', () => {
  const { claims, included, dropped } = buildBoundedWorkspaceClaim({ role: 'student' }, []);
  assert.deepEqual(included, []);
  assert.deepEqual(dropped, []);
  assert.deepEqual((claims as { workspaces: Record<string, boolean> }).workspaces, {});
});
