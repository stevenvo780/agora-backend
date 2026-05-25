/**
 * isStaleBlobUrl: una signed URL persistida en Firestore es obsoleta si su host
 * no coincide con NAS_S3_ENDPOINT actual. Cubre la regresión post-migración
 * s3.proxy.humanizar-dev.cloud → s3.elenxos.com (y Firebase Storage legacy):
 * el host viejo queda muerto + el CSP connect-src lo bloquea, así que el caller
 * debe regenerar on-read en vez de servir la URL guardada.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NAS_S3_ENDPOINT = 'https://s3.elenxos.com';

const { isStaleBlobUrl } = await import('../src/lib/nas-storage.ts');

test('detecta URL del host MinIO pre-migración como stale', () => {
  assert.equal(
    isStaleBlobUrl('https://s3.proxy.humanizar-dev.cloud/agora-blobs/workspaces/x/a.pdf?X-Amz-Signature=abc'),
    true
  );
});

test('detecta URL de Firebase Storage legacy como stale', () => {
  assert.equal(
    isStaleBlobUrl('https://storage.googleapis.com/udea.firebasestorage.app/docs/a.pdf'),
    true
  );
});

test('NO marca como stale una URL del endpoint actual', () => {
  assert.equal(
    isStaleBlobUrl('https://s3.elenxos.com/agora-blobs/workspaces/x/a.pdf?X-Amz-Signature=abc'),
    false
  );
});

test('valores no-string o vacíos no son stale', () => {
  assert.equal(isStaleBlobUrl(undefined), false);
  assert.equal(isStaleBlobUrl(null), false);
  assert.equal(isStaleBlobUrl(''), false);
  assert.equal(isStaleBlobUrl(123), false);
});

test('una URL malformada no se considera stale (no rompe el flujo)', () => {
  assert.equal(isStaleBlobUrl('not a url'), false);
});
