import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAgentSettings } from '../src/lib/agora-ai/agentSettingsStore.ts';

test('MiniMax conserva M3 como modelo principal y de continuidad', () => {
  assert.deepEqual(
    resolveAgentSettings(
      { mainModel: 'MiniMax-M3', auxModel: 'MiniMax-M3', autonomousMode: true },
      'minimax',
      'MiniMax-M3'
    ),
    { mainModel: 'MiniMax-M3', auxModel: 'MiniMax-M3', autonomousMode: true }
  );
});

test('descarta modelos conocidos de otra familia al cambiar de proveedor', () => {
  assert.deepEqual(
    resolveAgentSettings(
      { mainModel: 'deepseek-v4-pro', auxModel: 'deepseek-v4-flash', autonomousMode: false },
      'minimax',
      'MiniMax-M3'
    ),
    { mainModel: 'MiniMax-M3', auxModel: 'MiniMax-M3', autonomousMode: false }
  );
});

test('conserva ids custom que el catálogo todavía no conoce', () => {
  assert.deepEqual(
    resolveAgentSettings(
      { mainModel: 'MiniMax-M3-custom', auxModel: 'MiniMax-fast-custom' },
      'minimax',
      'MiniMax-M3'
    ),
    { mainModel: 'MiniMax-M3-custom', auxModel: 'MiniMax-fast-custom', autonomousMode: false }
  );
});
