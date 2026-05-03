import path from 'path';

export type MarkdownConversionResult = {
  markdown: string;
  suggestedName: string;
  sourceFormat: 'pdf' | 'docx' | 'text' | 'html' | 'unknown';
};

const getExtension = (fileName?: string) => {
  if (!fileName) return '';
  const ext = path.extname(fileName);
  return ext ? ext.slice(1).toLowerCase() : '';
};

const isPdf = (mime?: string, ext?: string) => {
  const lowerMime = (mime ?? '').toLowerCase();
  const lowerExt = (ext ?? '').toLowerCase();
  return lowerMime === 'application/pdf' || lowerExt === 'pdf';
};

const isDocx = (mime?: string, ext?: string) => {
  const lowerMime = (mime ?? '').toLowerCase();
  const lowerExt = (ext ?? '').toLowerCase();
  return lowerMime.includes('officedocument.wordprocessingml.document') || lowerExt === 'docx';
};

const isPlainText = (mime?: string, ext?: string) => {
  const lowerMime = (mime ?? '').toLowerCase();
  const lowerExt = (ext ?? '').toLowerCase();
  if (lowerMime.startsWith('text/')) return true;
  return ['md', 'markdown', 'txt', 'log', 'csv'].includes(lowerExt);
};

export const canConvertToMarkdown = (mimeType?: string, fileName?: string) => {
  const ext = getExtension(fileName);
  return isPdf(mimeType, ext) || isDocx(mimeType, ext) || isPlainText(mimeType, ext);
};

const normalizeMarkdown = (value: string) => {
  const unified = value.replace(/\r\n/g, '\n');
  return unified.replace(/\n{3,}/g, '\n\n').trim();
};

const pdfToMarkdown = async (buffer: Buffer): Promise<MarkdownConversionResult> => {
  const pdfModule = await import('pdf-parse');
  const pdfParse = (pdfModule.default ?? pdfModule) as (data: Buffer) => Promise<{ text?: string }>;
  const parsed = await pdfParse(buffer);
  const text = normalizeMarkdown(parsed.text ?? '');
  return {
    markdown: text || '# Documento PDF\nNo se pudo extraer texto legible.',
    suggestedName: 'documento.pdf.md',
    sourceFormat: 'pdf'
  };
};

const docxToMarkdown = async (buffer: Buffer): Promise<MarkdownConversionResult> => {
  const mammothModule = await import('mammoth');
  const convertToHtml = (mammothModule as { convertToHtml: (input: { buffer: Buffer }) => Promise<{ value: string }> }).convertToHtml;
  const { value: html } = await convertToHtml({ buffer });
  const TurndownService = (await import('turndown')).default as unknown as new () => { turndown: (input: string) => string };
  const turndown = new TurndownService();
  const markdown = normalizeMarkdown(turndown.turndown(html));
  return {
    markdown: markdown || '# Documento DOCX\nNo se pudo extraer contenido.',
    suggestedName: 'documento.docx.md',
    sourceFormat: 'docx'
  };
};

const textToMarkdown = async (buffer: Buffer, mimeType?: string): Promise<MarkdownConversionResult> => {
  const markdown = normalizeMarkdown(buffer.toString('utf8'));
  return {
    markdown,
    suggestedName: mimeType?.includes('markdown') ? 'documento.md' : 'documento.txt.md',
    sourceFormat: 'text'
  };
};

export const bufferToMarkdown = async (
  buffer: Buffer,
  options: { mimeType?: string; fileName?: string }
): Promise<MarkdownConversionResult> => {
  const ext = getExtension(options.fileName);
  if (isPdf(options.mimeType, ext)) {
    const base = options.fileName ? options.fileName.replace(/\.pdf$/i, '') : 'documento';
    const result = await pdfToMarkdown(buffer);
    return { ...result, suggestedName: `${base}.md` };
  }

  if (isDocx(options.mimeType, ext)) {
    const base = options.fileName ? options.fileName.replace(/\.docx$/i, '') : 'documento';
    const result = await docxToMarkdown(buffer);
    return { ...result, suggestedName: `${base}.md` };
  }

  if (isPlainText(options.mimeType, ext)) {
    const base = options.fileName ? options.fileName.replace(/\.[^.]+$/i, '') : 'documento';
    const result = await textToMarkdown(buffer, options.mimeType);
    return { ...result, suggestedName: `${base}.md` };
  }

  throw new Error('Tipo de archivo no soportado para conversión a Markdown');
};
