import { adminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import type { TacticRecord, TacticRetrieval } from './types';
import { rankByTfIdf } from './tfidf';

const COLLECTION = 'agentTactics';

// ---------------------------------------------------------------------------
// Minimal Firestore-compatible interface — permite inyectar un stub en tests.
// ---------------------------------------------------------------------------

interface DocData {
  [key: string]: unknown;
}

interface FakeDocSnap {
  id: string;
  exists: boolean;
  data(): DocData | undefined;
}

interface FakeQuerySnap {
  empty: boolean;
  docs: FakeDocSnap[];
}

interface FakeTx {
  get(ref: FakeDocRef): Promise<FakeDocSnap>;
  update(ref: FakeDocRef, data: DocData): void;
}

interface FakeDocRef {
  id: string;
}

interface FakeCollRef {
  add(data: DocData): Promise<{ id: string }>;
  get(): Promise<FakeQuerySnap>;
  doc(id: string): FakeDocRef & { get(): Promise<FakeDocSnap> };
}

interface FakeDb {
  collection(name: string): FakeCollRef;
  runTransaction<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------

let _db: FakeDb | null = null;

function getDb(): FakeDb {
  return _db ?? (adminDb as unknown as FakeDb);
}

/** Inyecta un stub de Firestore para tests. Pasar null restaura el real. */
export function __setDbForTest(stub: FakeDb | null): void {
  _db = stub;
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/** Persiste una nueva táctica y devuelve su id generado por Firestore. */
export async function recordTactic(record: Omit<TacticRecord, 'id'>): Promise<string> {
  const db = getDb();
  const ref = await db.collection(COLLECTION).add({
    questionPattern: record.questionPattern,
    keywords: record.keywords,
    tacticSequence: record.tacticSequence,
    successRate: record.successRate,
    usageCount: record.usageCount,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  });
  return ref.id;
}

/**
 * Recupera tácticas relevantes para una pregunta usando TF-IDF sobre keywords.
 * El campo de búsqueda combina questionPattern y keywords de cada táctica.
 */
export async function retrieveTactics(
  question: string,
  opts: { topK?: number } = {}
): Promise<TacticRetrieval> {
  const topK = opts.topK ?? 5;
  const db = getDb();

  const snap = await db.collection(COLLECTION).get();
  if (snap.empty) {
    return { matches: [], topMatch: undefined, confidence: 0 };
  }

  const records: TacticRecord[] = snap.docs.map((doc) => {
    const d = doc.data() ?? {};
    return {
      id: doc.id,
      questionPattern: (d['questionPattern'] as string | undefined) ?? '',
      keywords: (d['keywords'] as string[] | undefined) ?? [],
      tacticSequence:
        (d['tacticSequence'] as Array<{ tool: string; argsTemplate: string }> | undefined) ?? [],
      successRate: (d['successRate'] as number | undefined) ?? 0,
      usageCount: (d['usageCount'] as number | undefined) ?? 0
    };
  });

  // Corpus: questionPattern + keywords concatenados
  const corpus = records.map((r) => [r.questionPattern, ...r.keywords].join(' '));

  const scored = rankByTfIdf(question, corpus, topK);
  const positiveMatches = scored.filter((s) => s.score > 0);

  if (positiveMatches.length === 0) {
    return { matches: [], topMatch: undefined, confidence: 0 };
  }

  const matches: TacticRecord[] = positiveMatches.map((s) => records[s.index] as TacticRecord);
  const topScore = positiveMatches[0]?.score ?? 0;

  // Confidence normalizado: cosine similarity ya está en [0, 1]
  const confidence = Math.min(1, topScore);

  return {
    matches,
    topMatch: matches[0],
    confidence
  };
}

/**
 * Actualiza el successRate de una táctica con media ponderada incremental.
 * Incrementa usageCount en 1.
 */
export async function updateSuccessRate(tacticId: string, success: boolean): Promise<void> {
  const db = getDb();
  const coll = db.collection(COLLECTION);
  const docRef = coll.doc(tacticId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) {
      throw new Error(`Tactic ${tacticId} not found`);
    }
    const data = snap.data() ?? {};
    const currentRate = (data['successRate'] as number | undefined) ?? 0;
    const currentCount = (data['usageCount'] as number | undefined) ?? 0;

    // newRate = (currentRate * count + outcome) / (count + 1)
    const outcome = success ? 1 : 0;
    const newCount = currentCount + 1;
    const newRate = (currentRate * currentCount + outcome) / newCount;

    tx.update(docRef, {
      successRate: newRate,
      usageCount: newCount,
      updatedAt: FieldValue.serverTimestamp()
    });
  });
}
