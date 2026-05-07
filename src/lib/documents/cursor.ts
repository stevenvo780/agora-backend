export interface DocumentsListCursor {
  updatedAtMs: number;
  id: string;
}

export const encodeDocumentsCursor = (cursor: DocumentsListCursor): string => {
  const json = JSON.stringify({ u: cursor.updatedAtMs, i: cursor.id });
  return Buffer.from(json, 'utf8').toString('base64url');
};

export const decodeDocumentsCursor = (raw: string | null | undefined): DocumentsListCursor | null => {
  if (!raw) return null;
  try {
    const buf = Buffer.from(raw, 'base64url');
    if (buf.byteLength === 0) return null;
    const parsed = JSON.parse(buf.toString('utf8')) as { u?: unknown; i?: unknown };
    if (typeof parsed.u !== 'number' || !Number.isFinite(parsed.u)) return null;
    if (typeof parsed.i !== 'string' || parsed.i.length === 0) return null;
    return { updatedAtMs: parsed.u, id: parsed.i };
  } catch {
    return null;
  }
};
