import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  type CompletedPart
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'node:crypto';

const endpoint = process.env.NAS_S3_ENDPOINT?.trim();
const region = process.env.NAS_S3_REGION?.trim() || 'us-east-1';
const bucket = process.env.NAS_S3_BUCKET?.trim() || 'agora-blobs';
const accessKey = process.env.NAS_S3_ACCESS_KEY?.trim();
const secretKey = process.env.NAS_S3_SECRET_KEY?.trim();

let _client: S3Client | null = null;

export const isNasConfigured = (): boolean => Boolean(endpoint && accessKey && secretKey);

export const getNasBucket = (): string => bucket;

export const getNasClient = (): S3Client => {
  if (!_client) {
    if (!isNasConfigured()) {
      throw new Error('NAS S3 not configured (NAS_S3_ENDPOINT/ACCESS_KEY/SECRET_KEY required)');
    }
    _client = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId: accessKey!, secretAccessKey: secretKey! },
      forcePathStyle: true
    });
  }
  return _client;
};

export const objectExists = async (key: string): Promise<boolean> => {
  try {
    await getNasClient().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (e: unknown) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return false;
    throw e;
  }
};

export const putObject = async (
  key: string,
  body: Buffer | Uint8Array | string,
  opts: { contentType?: string; metadata?: Record<string, string> } = {}
): Promise<{ contentHash: string; size: number }> => {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
  const contentHash = crypto.createHash('sha256').update(buf).digest('hex');
  await getNasClient().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buf,
    ContentType: opts.contentType,
    Metadata: { 'agora-content-hash': contentHash, ...(opts.metadata ?? {}) }
  }));
  return { contentHash, size: buf.length };
};

export const getObjectBuffer = async (key: string): Promise<Buffer | null> => {
  try {
    const out = await getNasClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const stream = out.Body as ReadableStream<Uint8Array> | NodeJS.ReadableStream | undefined;
    if (!stream) return null;
    const chunks: Buffer[] = [];
    // node stream
    if (typeof (stream as NodeJS.ReadableStream).on === 'function') {
      await new Promise<void>((resolve, reject) => {
        (stream as NodeJS.ReadableStream)
          .on('data', (c: Buffer | Uint8Array | string) => {
            if (Buffer.isBuffer(c)) chunks.push(c);
            else if (c instanceof Uint8Array) chunks.push(Buffer.from(c.buffer, c.byteOffset, c.byteLength));
            else if (typeof c === 'string') chunks.push(Buffer.from(c, 'utf8'));
          })
          .on('end', () => resolve())
          .on('error', reject);
      });
      return Buffer.concat(chunks);
    }
    // web stream
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (value instanceof Uint8Array) chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      else chunks.push(Buffer.from(value as unknown as ArrayBuffer));
    }
    return Buffer.concat(chunks);
  } catch (e: unknown) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
};

export const deleteObject = async (key: string): Promise<void> => {
  await getNasClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
};

export const copyObject = async (fromKey: string, toKey: string): Promise<void> => {
  await getNasClient().send(new CopyObjectCommand({
    Bucket: bucket,
    CopySource: `/${bucket}/${encodeURIComponent(fromKey)}`,
    Key: toKey
  }));
};

export const moveObject = async (fromKey: string, toKey: string): Promise<void> => {
  if (fromKey === toKey) return;
  await copyObject(fromKey, toKey);
  await deleteObject(fromKey).catch(() => undefined);
};

export interface PresignGetOptions {
  /**
   * Override del Content-Disposition que MinIO devuelve. Útil para que
   * viewers externos (Office Online, Google Docs Viewer) identifiquen el
   * tipo de archivo cuando la URL firmada lleva query string que oculta
   * la extensión.
   */
  responseContentDisposition?: string;
  /** Override del Content-Type devuelto. */
  responseContentType?: string;
}

export const presignGet = async (
  key: string,
  ttlSeconds = 60 * 60,
  options: PresignGetOptions = {}
): Promise<string> => {
  return getSignedUrl(
    getNasClient(),
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: options.responseContentDisposition,
      ResponseContentType: options.responseContentType
    }),
    { expiresIn: ttlSeconds }
  );
};

export const presignPut = async (
  key: string,
  ttlSeconds = 15 * 60,
  contentType?: string
): Promise<string> => {
  return getSignedUrl(getNasClient(), new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), { expiresIn: ttlSeconds });
};

export const createMultipartUpload = async (
  key: string,
  contentType?: string
): Promise<string> => {
  const res = await getNasClient().send(new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType
  }));
  if (!res.UploadId) {
    throw new Error('createMultipartUpload: missing UploadId in response');
  }
  return res.UploadId;
};

export const presignUploadPart = async (
  key: string,
  uploadId: string,
  partNumber: number,
  ttlSeconds = 60 * 60
): Promise<string> => {
  return getSignedUrl(
    getNasClient(),
    new UploadPartCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber
    }),
    { expiresIn: ttlSeconds, unhoistableHeaders: new Set(['x-amz-content-sha256']) }
  );
};

export const completeMultipartUpload = async (
  key: string,
  uploadId: string,
  parts: ReadonlyArray<{ partNumber: number; etag: string }>
): Promise<{ location?: string; etag?: string }> => {
  const completed: CompletedPart[] = parts
    .slice()
    .sort((a, b) => a.partNumber - b.partNumber)
    .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag.startsWith('"') ? p.etag : `"${p.etag}"` }));
  const res = await getNasClient().send(new CompleteMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: { Parts: completed }
  }));
  return { location: res.Location, etag: res.ETag };
};

export const abortMultipartUpload = async (key: string, uploadId: string): Promise<void> => {
  await getNasClient().send(new AbortMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId
  }));
};

export const headObjectSize = async (key: string): Promise<number | null> => {
  try {
    const res = await getNasClient().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return typeof res.ContentLength === 'number' ? res.ContentLength : null;
  } catch (e: unknown) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
};
