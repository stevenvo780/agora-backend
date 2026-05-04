import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseSyncEventPayload,
  resolveSyncChannel,
  parseWorkerCommitPayload,
  parseWorkerDeletePayload,
  parseWorkerUploadUrlPayload
} from '@agora/contracts';

const syncFixtures = JSON.parse(readFileSync('../packages/agora-contracts/fixtures/sync-events.json', 'utf8'));

test('sync event fixtures parsean payload válido y rechazan timestamp ausente', () => {
  assert.equal(parseSyncEventPayload(syncFixtures.valid).ok, true);
  const invalid = parseSyncEventPayload(syncFixtures.invalidMissingTimestamp);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.match(invalid.error, /timestamp/);
});

test('sync channel fixtures cubren personal y shared', () => {
  const personal = resolveSyncChannel(syncFixtures.personalChannel);
  const shared = resolveSyncChannel(syncFixtures.sharedChannel);
  assert.equal(personal.ok, true);
  assert.equal(shared.ok, true);
  if (personal.ok) assert.equal(personal.value, syncFixtures.personalChannel.expected);
  if (shared.ok) assert.equal(shared.value, syncFixtures.sharedChannel.expected);
});

test('worker payload parsers rechazan traversal y tamaños inválidos', () => {
  assert.equal(parseWorkerCommitPayload({ repoPath: 'docs/a.md', contentHash: 'abc' }).ok, true);
  assert.equal(parseWorkerCommitPayload({ repoPath: '../a.md', contentHash: 'abc' }).ok, false);
  assert.equal(parseWorkerDeletePayload({ repoPath: 'docs/a.md' }).ok, true);
  assert.equal(parseWorkerDeletePayload({ repoPath: 'docs//a.md' }).ok, false);
  assert.equal(parseWorkerUploadUrlPayload({ repoPath: 'docs/a.md', size: 1 }).ok, true);
  assert.equal(parseWorkerUploadUrlPayload({ repoPath: 'docs/a.md', size: 0 }).ok, false);
});
