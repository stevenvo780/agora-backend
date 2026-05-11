import test from 'node:test';
import assert from 'node:assert/strict';

process.env.WORKER_SECRET = 'unit-test-worker-secret-must-be-long-enough';

const {
  encryptAgentSecret,
  decryptAgentSecret,
  buildDisplayHint,
  __resetAgentVaultCache
} = await import('../src/lib/agora-ai/agentVault.ts');

test('encrypt/decrypt agent secret roundtrip', () => {
  __resetAgentVaultCache();
  const plaintext = 'sk-test-1234567890abcdef';
  const enc = encryptAgentSecret(plaintext);
  assert.equal(typeof enc.keyEncrypted, 'string');
  assert.equal(typeof enc.iv, 'string');
  assert.equal(typeof enc.authTag, 'string');
  assert.equal(enc.kid, 'k1');
  // Importante: el ciphertext base64 no debe contener el plaintext.
  assert.equal(enc.keyEncrypted.includes(plaintext), false);
  const dec = decryptAgentSecret(enc);
  assert.equal(dec, plaintext);
});

test('decrypt tampered ciphertext returns null', () => {
  __resetAgentVaultCache();
  const enc = encryptAgentSecret('sk-test-1');
  // Flip un byte del ciphertext.
  const tampered = Buffer.from(enc.keyEncrypted, 'base64');
  if (tampered[0] !== undefined) tampered[0] = tampered[0] ^ 0xff;
  const result = decryptAgentSecret({
    ...enc,
    keyEncrypted: tampered.toString('base64')
  });
  assert.equal(result, null);
});

test('decrypt with bad kid returns null', () => {
  __resetAgentVaultCache();
  const enc = encryptAgentSecret('sk-test-2');
  const result = decryptAgentSecret({ ...enc, kid: 'k0' });
  assert.equal(result, null);
});

test('encrypt with empty plaintext throws', () => {
  __resetAgentVaultCache();
  assert.throws(() => encryptAgentSecret(''), /vacío/);
});

test('buildDisplayHint hides body and keeps last 4', () => {
  assert.equal(buildDisplayHint('sk-test-abcdefgh1234'), '***1234');
  assert.equal(buildDisplayHint('abc'), '***abc');
  assert.equal(buildDisplayHint('1234'), '***1234');
});
