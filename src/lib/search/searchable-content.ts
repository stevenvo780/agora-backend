/**
 * Helpers para denormalizar `searchableContent` en docs de Firestore.
 *
 * Motivación: el endpoint /api/search/semantic hidrataba inline desde MinIO
 * (80×256KB por keystroke) para poder rankear por contenido. Con
 * `searchableContent` persistido en el doc, el ranker lee directo desde el
 * snapshot Firestore sin tocar MinIO.
 */

const MAX_SEARCHABLE_LENGTH = 4000;

/**
 * Stripea sintaxis markdown común para producir un blob plain-text apto
 * para ranking heurístico. NO pretende reproducir un parser MDX completo;
 * sólo quitar el ruido que infla los tokens (fences, símbolos de heading,
 * énfasis, links). Conserva el texto humano legible.
 */
export function stripMarkdown(content: string): string {
  if (!content) return '';
  let text = content;

  // 1. Frontmatter YAML al inicio: lo conservamos como texto plano
  // (los keys author/title/tags son señales útiles para el ranker), sólo
  // quitamos los delimitadores `---`.
  text = text.replace(/^---\s*\n([\s\S]*?)\n---\s*/m, (_full, fm: string) => `${fm}\n`);

  // 2. Code fences: preservar texto interno, quitar las marcas ```lang
  text = text.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, (_full, body: string) => body);
  text = text.replace(/~~~[a-zA-Z0-9_-]*\n([\s\S]*?)~~~/g, (_full, body: string) => body);

  // 3. Inline code `x`
  text = text.replace(/`([^`]+)`/g, '$1');

  // 4. Headings: # foo => foo
  text = text.replace(/^#{1,6}\s+/gm, '');

  // 5. Bold/italic markers (**, __, *, _) — preservar el contenido.
  text = text.replace(/(\*\*|__)(.+?)\1/g, '$2');
  text = text.replace(/(\*|_)(.+?)\1/g, '$2');

  // 6. Links / images: [txt](url) => txt; ![alt](src) => alt
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // 7. Blockquotes
  text = text.replace(/^\s*>\s?/gm, '');

  // 8. Horizontal rules
  text = text.replace(/^\s*[-*_]{3,}\s*$/gm, '');

  // 9. List markers (-, *, +, números) al inicio de línea
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*\d+\.\s+/gm, '');

  // 10. Tablas: pipes en la frontera
  text = text.replace(/\|/g, ' ');

  // 11. Colapsar whitespace
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

/**
 * Computa el blob denormalizado para guardar en Firestore.
 * - Si content es vacío o no string → retorna ''.
 * - Stripea markdown y trunca a MAX_SEARCHABLE_LENGTH chars.
 */
export function computeSearchableContent(content: unknown): string {
  if (typeof content !== 'string' || content.length === 0) return '';
  const stripped = stripMarkdown(content);
  if (stripped.length <= MAX_SEARCHABLE_LENGTH) return stripped;
  return stripped.slice(0, MAX_SEARCHABLE_LENGTH);
}

export const SEARCHABLE_CONTENT_MAX_LENGTH = MAX_SEARCHABLE_LENGTH;
