const STOPWORDS = new Set([
  'a', 'al', 'algo', 'ante', 'como', 'con', 'contra', 'de', 'del', 'desde', 'donde', 'e', 'el', 'ella', 'ellas', 'ellos', 'en', 'entre', 'era', 'eran', 'es', 'esa', 'ese', 'eso', 'esta', 'este', 'esto', 'fue', 'ha', 'hay', 'la', 'las', 'le', 'les', 'lo', 'los', 'más', 'mi', 'mis', 'mucho', 'muy', 'no', 'nos', 'o', 'para', 'pero', 'por', 'que', 'qué', 'se', 'ser', 'si', 'sin', 'sobre', 'su', 'sus', 'te', 'tiene', 'tu', 'un', 'una', 'uno', 'y',
  'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'if', 'in', 'into', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'their', 'there', 'this', 'to', 'was', 'were', 'with'
]);

const normalizeText = (markdown: string) => markdown
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  .replace(/\[[^\]]+\]\(([^)]+)\)/g, ' $1 ')
  .replace(/^>\s?/gm, '')
  .replace(/^#{1,6}\s+/gm, '')
  .replace(/[*_~]/g, ' ')
  .replace(/\r\n?/g, '\n')
  .replace(/\n{2,}/g, '\n')
  .trim();

const tokenize = (text: string) => text
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .match(/[a-z0-9]+/g) ?? [];

export const extractMarkdownHeadings = (markdown: string) => markdown
  .split(/\r?\n/)
  .map((line) => line.match(/^#{1,6}\s+(.+)$/)?.[1]?.trim())
  .filter((line): line is string => Boolean(line));

export const analyzeMarkdown = (markdown: string) => {
  const normalized = normalizeText(markdown);
  const words = tokenize(normalized);
  const lines = markdown.split(/\r?\n/);
  const headings = extractMarkdownHeadings(markdown);
  const checklistItems = lines.filter((line) => /^\s*- \[[ xX]\]/.test(line)).length;
  const links = (markdown.match(/\[[^\]]+\]\(([^)]+)\)/g) ?? []).length;
  const formulas = (markdown.match(/\$\$?[\s\S]*?\$\$?/g) ?? []).length;
  const codeBlocks = (markdown.match(/```[\s\S]*?```/g) ?? []).length;
  const paragraphs = normalized.split(/\n{2,}/).filter(Boolean).length;
  return {
    wordCount: words.length,
    lineCount: lines.length,
    characterCount: markdown.length,
    headingCount: headings.length,
    headings,
    checklistItems,
    linkCount: links,
    formulaCount: formulas,
    codeBlockCount: codeBlocks,
    paragraphCount: paragraphs,
    readingTimeMinutes: Math.max(1, Math.round(words.length / 180))
  };
};

const splitSentences = (text: string) => text
  .split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÜÑ0-9])/u)
  .map((sentence) => sentence.trim())
  .filter(Boolean);

export const summarizeMarkdown = (markdown: string, maxSentences = 4) => {
  const normalized = normalizeText(markdown);
  const headings = extractMarkdownHeadings(markdown);
  const sentences = splitSentences(normalized);
  if (!sentences.length) {
    return {
      summary: headings.slice(0, 3).join(' · ') || normalized.slice(0, 220),
      headings
    };
  }

  const frequencies = tokenize(normalized).reduce<Record<string, number>>((acc, token) => {
    if (!STOPWORDS.has(token) && token.length > 2) {
      acc[token] = (acc[token] ?? 0) + 1;
    }
    return acc;
  }, {});

  const scored = sentences.map((sentence, index) => {
    const score = tokenize(sentence).reduce((acc, token) => acc + (frequencies[token] ?? 0), 0);
    const headingBonus = headings.some((heading) => sentence.includes(heading)) ? 4 : 0;
    return { sentence, index, score: score + headingBonus };
  });

  const summary = scored
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, maxSentences)
    .sort((left, right) => left.index - right.index)
    .map((item) => item.sentence)
    .join(' ')
    .trim();

  return {
    summary: summary || sentences.slice(0, maxSentences).join(' '),
    headings
  };
};

const normalizeHeadingKey = (value: string) => value.trim().toLowerCase();

export const compareMarkdownDocuments = (left: string, right: string) => {
  const leftAnalysis = analyzeMarkdown(left);
  const rightAnalysis = analyzeMarkdown(right);
  const leftTokens = new Set(tokenize(normalizeText(left)).filter((token) => !STOPWORDS.has(token)));
  const rightTokens = new Set(tokenize(normalizeText(right)).filter((token) => !STOPWORDS.has(token)));
  const sharedTokens = [...leftTokens].filter((token) => rightTokens.has(token));
  const union = new Set([...leftTokens, ...rightTokens]);
  const similarity = union.size ? Number((sharedTokens.length / union.size).toFixed(3)) : 1;

  const leftHeadingMap = new Map(leftAnalysis.headings.map((heading) => [normalizeHeadingKey(heading), heading]));
  const rightHeadingMap = new Map(rightAnalysis.headings.map((heading) => [normalizeHeadingKey(heading), heading]));
  const sharedHeadings = [...leftHeadingMap.keys()]
    .filter((key) => rightHeadingMap.has(key))
    .map((key) => leftHeadingMap.get(key) as string);
  const leftOnlyHeadings = [...leftHeadingMap.keys()]
    .filter((key) => !rightHeadingMap.has(key))
    .map((key) => leftHeadingMap.get(key) as string);
  const rightOnlyHeadings = [...rightHeadingMap.keys()]
    .filter((key) => !leftHeadingMap.has(key))
    .map((key) => rightHeadingMap.get(key) as string);

  return {
    similarity,
    sharedKeywords: sharedTokens.slice(0, 20),
    sharedHeadings,
    leftOnlyHeadings,
    rightOnlyHeadings,
    leftAnalysis,
    rightAnalysis
  };
};

export const extractChecklistTasks = (markdown: string) => markdown
  .split(/\r?\n/)
  .map((line) => line.match(/^\s*- \[ \]\s+(.+)$/)?.[1]?.trim())
  .filter((task): task is string => Boolean(task));
