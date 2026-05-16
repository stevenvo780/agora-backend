/**
 * TF-IDF keyword retrieval para tactics-rag.
 * Extensible: el retriever puede ser reemplazado por embeddings reales
 * sin cambiar la interfaz de recordTactic/retrieveTactics.
 */

/** Tokeniza y normaliza texto en terms. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-záéíóúüñ0-9_\- ]/gi, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** TF: frecuencia de cada term en el doc (normalizada por longitud). */
function computeTf(terms: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  if (terms.length === 0) return tf;
  for (const t of terms) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  for (const [t, count] of tf) {
    tf.set(t, count / terms.length);
  }
  return tf;
}

/** IDF: log(N / df) para cada term del corpus. */
function computeIdf(docs: string[][]): Map<string, number> {
  const df = new Map<string, number>();
  const N = docs.length;
  for (const doc of docs) {
    const seen = new Set(doc);
    for (const t of seen) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [t, count] of df) {
    idf.set(t, Math.log((N + 1) / (count + 1)) + 1);
  }
  return idf;
}

/** Cosine similarity entre dos vectores representados como Maps. */
function cosineSim(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const [t, va] of a) {
    dot += va * (b.get(t) ?? 0);
    normA += va * va;
  }
  for (const [, vb] of b) {
    normB += vb * vb;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export interface ScoredDoc {
  index: number;
  score: number;
}

/**
 * Rankea documentos por similitud TF-IDF cosine contra una query.
 * @param query - texto libre de búsqueda
 * @param docs  - lista de strings (keywords concatenadas) de cada documento
 * @param topK  - cuántos resultados retornar (default 5)
 */
export function rankByTfIdf(query: string, docs: string[], topK = 5): ScoredDoc[] {
  if (docs.length === 0) return [];

  const queryTerms = tokenize(query);
  const docTermsList = docs.map((d) => tokenize(d));

  const allTermsList = [queryTerms, ...docTermsList];
  const idf = computeIdf(allTermsList);

  const toTfIdf = (terms: string[]): Map<string, number> => {
    const tf = computeTf(terms);
    const vec = new Map<string, number>();
    for (const [t, tfVal] of tf) {
      vec.set(t, tfVal * (idf.get(t) ?? 1));
    }
    return vec;
  };

  const queryVec = toTfIdf(queryTerms);
  const scored: ScoredDoc[] = docTermsList.map((terms, index) => ({
    index,
    score: cosineSim(queryVec, toTfIdf(terms))
  }));

  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}
