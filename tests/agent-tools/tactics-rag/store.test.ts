/**
 * Tests del módulo tactics-rag/store.
 *
 * Usa un stub en-memoria de Firestore para evitar dependencias externas.
 * Cubre: record+retrieve roundtrip, selección del topMatch correcto
 * cuando hay múltiples tácticas, y actualización de successRate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Stub Firestore en-memoria
// ---------------------------------------------------------------------------

let autoId = 0;

interface DocData {
  [key: string]: unknown;
}

interface DocEntry {
  id: string;
  data: DocData;
}

function makeDb() {
  const store = new Map<string, DocEntry>();

  return {
    _store: store,

    collection(_name: string) {
      return {
        async add(data: DocData): Promise<{ id: string }> {
          const id = `tactic-${++autoId}`;
          // Filtrar sentinels de FieldValue (serverTimestamp): guardar null
          const clean: DocData = {};
          for (const [k, v] of Object.entries(data)) {
            clean[k] = isFieldValueSentinel(v) ? null : v;
          }
          store.set(id, { id, data: clean });
          return { id };
        },

        async get() {
          const docs = Array.from(store.values()).map((entry) => ({
            id: entry.id,
            exists: true,
            data: () => entry.data
          }));
          return { empty: docs.length === 0, docs };
        },

        doc(id: string) {
          return {
            id,
            async get() {
              const entry = store.get(id);
              return {
                id,
                exists: entry !== undefined,
                data: () => entry?.data
              };
            }
          };
        }
      };
    },

    async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const tx = {
        async get(ref: { id: string }) {
          const entry = store.get(ref.id);
          return {
            id: ref.id,
            exists: entry !== undefined,
            data: () => entry?.data
          };
        },
        update(ref: { id: string }, data: DocData) {
          const entry = store.get(ref.id);
          if (!entry) throw new Error(`Doc ${ref.id} not found`);
          const clean: DocData = {};
          for (const [k, v] of Object.entries(data)) {
            clean[k] = isFieldValueSentinel(v) ? null : v;
          }
          entry.data = { ...entry.data, ...clean };
        }
      };
      return fn(tx);
    }
  };
}

/** Detecta los sentinels de firebase-admin/firestore (FieldValue). */
function isFieldValueSentinel(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v !== 'object') return false;
  // Los sentinels de FieldValue no son POJOs estándar
  const name = Object.prototype.toString.call(v);
  return name.includes('FieldTransform') || name.includes('FieldValue');
}

// ---------------------------------------------------------------------------
// Importar el módulo bajo prueba DESPUÉS de setear el stub
// ---------------------------------------------------------------------------

const { recordTactic, retrieveTactics, updateSuccessRate, __setDbForTest } = await import(
  '../../../src/lib/agora-ai/tactics-rag/store.ts'
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('record + retrieve roundtrip', async () => {
  const db = makeDb();
  __setDbForTest(db as Parameters<typeof __setDbForTest>[0]);

  const id = await recordTactic({
    questionPattern: 'cómo formalizar una proposición lógica',
    keywords: ['formalizar', 'proposición', 'lógica', 'st'],
    tacticSequence: [{ tool: 'st_parse', argsTemplate: '{"expr":"{{input}}"}' }],
    successRate: 0.8,
    usageCount: 10
  });

  assert.equal(typeof id, 'string');
  assert.ok(id.length > 0);

  const result = await retrieveTactics('cómo formalizar proposición lógica');

  assert.ok(result.matches.length > 0, 'debe retornar al menos un match');
  assert.ok(result.topMatch !== undefined, 'topMatch debe existir');
  assert.equal(result.topMatch?.id, id);
  assert.ok(result.confidence > 0, 'confidence debe ser positiva');

  __setDbForTest(null);
});

test('3 tácticas distintas → query con keywords de tactic 2 → topMatch = tactic 2', async () => {
  const db = makeDb();
  __setDbForTest(db as Parameters<typeof __setDbForTest>[0]);

  // Tactic 1: sobre citaciones y grafos
  await recordTactic({
    questionPattern: 'encontrar citas relacionadas con un documento',
    keywords: ['citas', 'grafo', 'citaciones', 'referencias', 'encontrar'],
    tacticSequence: [{ tool: 'query_citation_graph', argsTemplate: '{"docId":"{{id}}"}' }],
    successRate: 0.75,
    usageCount: 5
  });

  // Tactic 2: sobre ejecución de comandos en el worker
  const id2 = await recordTactic({
    questionPattern: 'ejecutar comando shell en el workspace del usuario',
    keywords: ['ejecutar', 'comando', 'shell', 'workspace', 'worker', 'terminal'],
    tacticSequence: [{ tool: 'run_command', argsTemplate: '{"cmd":"{{command}}"}' }],
    successRate: 0.9,
    usageCount: 20
  });

  // Tactic 3: sobre lectura de archivos
  await recordTactic({
    questionPattern: 'leer el contenido de un archivo del workspace',
    keywords: ['leer', 'archivo', 'contenido', 'workspace', 'read', 'file'],
    tacticSequence: [{ tool: 'read_file', argsTemplate: '{"path":"{{path}}"}' }],
    successRate: 0.85,
    usageCount: 15
  });

  // Query con términos únicos de tactic 2
  const result = await retrieveTactics('ejecutar shell comando terminal worker', { topK: 3 });

  assert.ok(result.topMatch !== undefined, 'debe haber topMatch');
  assert.equal(
    result.topMatch?.id,
    id2,
    `topMatch debería ser tactic 2 (${id2}), fue ${result.topMatch?.id}`
  );
  assert.ok(result.confidence > 0);

  __setDbForTest(null);
});

test('updateSuccessRate actualiza correctamente (éxito)', async () => {
  const db = makeDb();
  __setDbForTest(db as Parameters<typeof __setDbForTest>[0]);

  const id = await recordTactic({
    questionPattern: 'test de actualización de tasa',
    keywords: ['test', 'actualizar', 'tasa'],
    tacticSequence: [],
    successRate: 0.5,
    usageCount: 4
  });

  // Con successRate=0.5, usageCount=4 → acum = 0.5*4 = 2
  // Nuevo éxito: (2+1)/(4+1) = 3/5 = 0.6
  await updateSuccessRate(id, true);

  const result = await retrieveTactics('test actualizar tasa');
  const updated = result.matches.find((m) => m.id === id);
  assert.ok(updated !== undefined, 'debe encontrar la táctica actualizada');
  assert.ok(
    Math.abs((updated?.successRate ?? 0) - 0.6) < 0.0001,
    `successRate esperado 0.6, recibido ${updated?.successRate}`
  );
  assert.equal(updated?.usageCount, 5);

  __setDbForTest(null);
});

test('updateSuccessRate actualiza correctamente (fracaso)', async () => {
  const db = makeDb();
  __setDbForTest(db as Parameters<typeof __setDbForTest>[0]);

  const id = await recordTactic({
    questionPattern: 'test fracaso tasa negativa',
    keywords: ['fracaso', 'fallo', 'error'],
    tacticSequence: [],
    successRate: 1.0,
    usageCount: 2
  });

  // successRate=1.0, usageCount=2 → acum=2
  // Fracaso: (2+0)/(2+1) = 2/3 ≈ 0.6667
  await updateSuccessRate(id, false);

  const result = await retrieveTactics('fracaso fallo error');
  const updated = result.matches.find((m) => m.id === id);
  assert.ok(updated !== undefined);
  const expected = 2 / 3;
  assert.ok(
    Math.abs((updated?.successRate ?? 0) - expected) < 0.0001,
    `successRate esperado ${expected}, recibido ${updated?.successRate}`
  );
  assert.equal(updated?.usageCount, 3);

  __setDbForTest(null);
});

test('retrieveTactics devuelve vacío cuando no hay tácticas', async () => {
  const db = makeDb();
  __setDbForTest(db as Parameters<typeof __setDbForTest>[0]);

  const result = await retrieveTactics('cualquier pregunta sin tácticas');
  assert.deepEqual(result.matches, []);
  assert.equal(result.topMatch, undefined);
  assert.equal(result.confidence, 0);

  __setDbForTest(null);
});

test('updateSuccessRate lanza error si tacticId no existe', async () => {
  const db = makeDb();
  __setDbForTest(db as Parameters<typeof __setDbForTest>[0]);

  await assert.rejects(
    () => updateSuccessRate('id-inexistente', true),
    /not found/i
  );

  __setDbForTest(null);
});
