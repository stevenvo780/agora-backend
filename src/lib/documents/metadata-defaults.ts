/**
 * Helpers para derivar `mimeType` y `name` cuando POST/PUT /api/documents
 * los recibe vacíos. El front rechaza `mimeType: null` (schema Zod) y
 * la búsqueda muestra filename literal si `name === 'Sin titulo'`.
 */
import { DocumentType, type DocumentTypeId } from '@/types/documents';

const TEXT_EXT_TO_MIME: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'text/plain',
  '.ini': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.scss': 'text/css',
  '.sass': 'text/css',
  '.less': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.cjs': 'application/javascript',
  '.ts': 'application/typescript',
  '.tsx': 'application/typescript',
  '.jsx': 'application/javascript',
  '.py': 'text/x-python',
  '.rb': 'text/x-ruby',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.sh': 'application/x-sh',
  '.bash': 'application/x-sh',
  '.zsh': 'application/x-sh',
  '.fish': 'application/x-sh',
  '.env': 'text/plain',
  '.conf': 'text/plain',
  '.cfg': 'text/plain',
  '.diff': 'text/x-diff',
  '.patch': 'text/x-diff',
  '.st': 'text/plain',
  '.sql': 'application/sql'
};

const BINARY_EXT_TO_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.zip': 'application/zip'
};

const extOf = (name: string): string => {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) return '';
  return lower.slice(dot);
};

/**
 * Devuelve un mimeType válido (nunca null) para un doc dado su tipo y nombre.
 * Se usa al crear/actualizar docs vía API para no caer al schema Zod del front
 * que exige `mimeType: string` en `resolvedDocumentMetaSchema`.
 */
export const resolveDocumentMimeType = (
  rawMimeType: string | null | undefined,
  type: DocumentTypeId | string,
  name: string
): string => {
  if (typeof rawMimeType === 'string' && rawMimeType.trim().length > 0) {
    return rawMimeType.trim();
  }
  const ext = extOf(name);
  if (type === DocumentType.Folder) return 'inode/directory';
  if (type === DocumentType.Text) {
    return TEXT_EXT_TO_MIME[ext] ?? 'text/markdown';
  }
  if (type === DocumentType.File) {
    return BINARY_EXT_TO_MIME[ext] ?? TEXT_EXT_TO_MIME[ext] ?? 'application/octet-stream';
  }
  // Tipos "virtuales" (st-runner, board, agora-ai, terminal, semantic-browser,
  // formalizer, files) son docs lógicos sin blob real — usamos un mime
  // descriptivo en vez de null para satisfacer el schema del front.
  return TEXT_EXT_TO_MIME[ext] ?? 'application/json';
};

/**
 * Si `name` está vacío o es el default `'Sin titulo'` y el `content` arranca
 * con un H1 markdown (`^# ...`), devuelve ese H1 como título. Si no, devuelve
 * el name original (o el fallback).
 */
export const deriveDocumentName = (
  rawName: string | null | undefined,
  content: string | null | undefined,
  fallback: string = 'Sin titulo'
): string => {
  const trimmed = typeof rawName === 'string' ? rawName.trim() : '';
  const isPlaceholder = trimmed.length === 0 || trimmed.toLowerCase() === 'sin titulo';
  if (!isPlaceholder) return trimmed;
  if (typeof content !== 'string' || content.length === 0) {
    return trimmed.length > 0 ? trimmed : fallback;
  }
  // Acepta `#`/`##`/`###` solo si es la primera línea no vacía y no es ATX-cerrado raro.
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const match = /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) return trimmed.length > 0 ? trimmed : fallback;
    const heading = match[1]?.trim();
    if (heading && heading.length > 0) {
      // Limita longitud a algo razonable para nombre de archivo + Firestore.
      return heading.slice(0, 200);
    }
    return trimmed.length > 0 ? trimmed : fallback;
  }
  return trimmed.length > 0 ? trimmed : fallback;
};
