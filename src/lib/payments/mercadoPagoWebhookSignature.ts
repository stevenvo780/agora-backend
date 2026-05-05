import crypto from 'node:crypto';

interface VerifyMercadoPagoWebhookSignatureOptions {
  secret: string;
  signatureHeader: string;
  requestId: string;
  dataId: string | number | undefined;
}

export function buildMercadoPagoWebhookSignature(secret: string, dataId: string | number, requestId: string, ts: string) {
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  return crypto.createHmac('sha256', secret).update(manifest).digest('hex');
}

export function verifyMercadoPagoWebhookSignature({
  secret,
  signatureHeader,
  requestId,
  dataId
}: VerifyMercadoPagoWebhookSignatureOptions): boolean {
  if (!secret) {
    console.warn('[mp-webhook] No secret configured — rejecting all webhooks');
    return false;
  }
  if (!signatureHeader || !requestId || !dataId) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(',').map((part) => part.trim().split('=', 2) as [string, string])
  );
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return false;

  const expected = buildMercadoPagoWebhookSignature(secret, dataId, requestId, ts);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(v1, 'hex'));
  } catch {
    return false;
  }
}
