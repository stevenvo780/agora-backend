/**
 * Payloads de endpoints `/api/` con auth Firebase (no HMAC). Mismo patrón
 * que worker-payloads, pero para body que viene del cliente browser.
 */
import { err, fieldErr, isNumber, isObject, isString, ok, type ParseResult } from './result';

export interface SnippetCreatePayload {
  title: string;
  description: string;
  markdown: string;
  workspaceId: string | null;
  category: string;
  order: number;
}

export const parseSnippetCreatePayload = (input: unknown): ParseResult<SnippetCreatePayload> => {
  if (!isObject(input)) return err('body must be a JSON object');
  const { title, description, markdown, workspaceId, category, order } = input;
  if (!isString(title) || !title.trim()) return fieldErr('title', 'non-empty string', title);
  if (!isString(markdown)) return fieldErr('markdown', 'string', markdown);
  return ok({
    title: title.trim(),
    description: isString(description) ? description.trim() : '',
    markdown,
    workspaceId: isString(workspaceId) && workspaceId ? workspaceId : null,
    category: isString(category) && category.trim() ? category.trim() : 'general',
    order: isNumber(order) ? order : 0
  });
};

export interface DocumentCreatePayload {
  name: string;
  type: string;
  content: string | null;
  workspaceId: string | null;
  folder: string | null;
  mimeType: string | null;
  url: string | null;
  storagePath: string | null;
  order: number | null;
}

export const parseDocumentCreatePayload = (input: unknown): ParseResult<DocumentCreatePayload> => {
  if (!isObject(input)) return err('body must be a JSON object');
  const { name, type, content, workspaceId, folder, mimeType, url, storagePath, order } = input;
  return ok({
    name: isString(name) && name.trim() ? name : 'Sin titulo',
    type: isString(type) ? type : 'text',
    content: isString(content) ? content : null,
    workspaceId: isString(workspaceId) && workspaceId ? workspaceId : null,
    folder: isString(folder) ? folder : null,
    mimeType: isString(mimeType) ? mimeType : null,
    url: isString(url) ? url : null,
    storagePath: isString(storagePath) ? storagePath : null,
    order: isNumber(order) ? order : null
  });
};
