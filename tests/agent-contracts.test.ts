import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChatCreatePayload,
  parseChatPatchPayload,
  parseChatMessageAppendPayload,
  clampListLimit,
  clampMessagesLimit
} from '../src/lib/agora-ai/chatPersistence.ts';
import {
  parseAgentKeySavePayload,
  AGENT_PROVIDER_VALUES
} from '../src/lib/agora-ai/agentSecretsStore.ts';

test('parseChatCreatePayload acepta body vacío', () => {
  const r = parseChatCreatePayload({});
  assert.equal(r.ok, true);
});

test('parseChatCreatePayload normaliza title', () => {
  const r = parseChatCreatePayload({ title: '  Hola mundo  ' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.title, 'Hola mundo');
});

test('parseChatCreatePayload rechaza title gigante', () => {
  const r = parseChatCreatePayload({ title: 'x'.repeat(500) });
  assert.equal(r.ok, false);
});

test('parseChatPatchPayload exige title presente', () => {
  const r = parseChatPatchPayload({});
  assert.equal(r.ok, false);
});

test('parseChatMessageAppendPayload valida role', () => {
  const ok = parseChatMessageAppendPayload({ role: 'assistant', content: 'hola' });
  assert.equal(ok.ok, true);
  const bad = parseChatMessageAppendPayload({ role: 'system', content: 'no' });
  assert.equal(bad.ok, false);
});

test('parseAgentKeySavePayload exige provider y key', () => {
  const bad1 = parseAgentKeySavePayload({});
  assert.equal(bad1.ok, false);
  const bad2 = parseAgentKeySavePayload({ provider: 'openai' });
  assert.equal(bad2.ok, false);
  const bad3 = parseAgentKeySavePayload({ provider: 'unknown', key: 'sk-x' });
  assert.equal(bad3.ok, false);
  const good = parseAgentKeySavePayload({ provider: 'openai', key: 'sk-test-1234' });
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.value.provider, 'openai');
    assert.equal(good.value.key, 'sk-test-1234');
  }
});

test('AGENT_PROVIDER_VALUES incluye los proveedores esperados', () => {
  for (const p of ['openai', 'anthropic', 'deepseek', 'gemini', 'agora-gateway', 'custom']) {
    assert.equal((AGENT_PROVIDER_VALUES as readonly string[]).includes(p), true, p);
  }
});

test('clampListLimit aplica defaults y techo', () => {
  assert.equal(clampListLimit(undefined), 30);
  assert.equal(clampListLimit('abc'), 30);
  assert.equal(clampListLimit('10'), 10);
  assert.equal(clampListLimit('99999'), 200);
});

test('clampMessagesLimit aplica defaults y techo', () => {
  assert.equal(clampMessagesLimit(undefined), 50);
  assert.equal(clampMessagesLimit('200'), 200);
  assert.equal(clampMessagesLimit('99999'), 500);
});
