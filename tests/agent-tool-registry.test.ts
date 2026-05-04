import test from 'node:test';
import assert from 'node:assert/strict';
import { AGORA_AGENT_TOOL_NAMES } from '../src/lib/agora-ai/toolDefinitions.ts';
import {
  AGORA_AGENT_TOOL_REGISTRY,
  AGORA_AGENT_TOOL_REGISTRY_BY_NAME,
  isCacheableAgentTool,
  isDestructiveAgentTool
} from '../src/lib/agora-ai/toolRegistry.ts';

test('tool registry cubre todas las tool definitions', () => {
  assert.equal(AGORA_AGENT_TOOL_REGISTRY.length, AGORA_AGENT_TOOL_NAMES.length);
  for (const name of AGORA_AGENT_TOOL_NAMES) {
    assert.equal(AGORA_AGENT_TOOL_REGISTRY_BY_NAME.has(name), true, `missing ${name}`);
  }
});

test('tool registry expone capability y policy flags críticos', () => {
  assert.equal(AGORA_AGENT_TOOL_REGISTRY_BY_NAME.get('read_document')?.capability, 'documentsRead');
  assert.equal(AGORA_AGENT_TOOL_REGISTRY_BY_NAME.get('run_worker_command')?.capability, 'workerCommand');
  assert.equal(isCacheableAgentTool('read_document'), true);
  assert.equal(isDestructiveAgentTool('run_worker_command'), true);
  assert.equal(isDestructiveAgentTool('read_document'), false);
});
