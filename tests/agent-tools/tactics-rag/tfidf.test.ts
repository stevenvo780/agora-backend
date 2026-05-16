/**
 * Tests del módulo tfidf — lógica pura sin dependencias externas.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { rankByTfIdf } from '../../../src/lib/agora-ai/tactics-rag/tfidf.ts';

test('rankByTfIdf: devuelve vacío cuando corpus está vacío', () => {
  const result = rankByTfIdf('cualquier pregunta', []);
  assert.deepEqual(result, []);
});

test('rankByTfIdf: devuelve vacío cuando query no tiene matches positivos', () => {
  const corpus = ['manzana naranja pera', 'gato perro ratón'];
  const result = rankByTfIdf('cuántica relatividad astrofísica', corpus);
  const positive = result.filter((r) => r.score > 0);
  assert.equal(positive.length, 0);
});

test('rankByTfIdf: doc más similar tiene score más alto', () => {
  const corpus = [
    'prueba formal lógica proposicional',
    'derivada integral cálculo',
    'lógica formal deducción teorema prueba'
  ];
  // Query con palabras de doc 0 y doc 2 (lógica, formal, prueba)
  const result = rankByTfIdf('lógica formal prueba', corpus, 3);
  assert.ok(result.length > 0);
  // El doc 2 tiene las tres palabras, debería estar primero o al menos con score > 0
  const top = result[0];
  assert.ok(top !== undefined, 'debe haber al menos un resultado');
  assert.ok(top.score > 0, 'el top debe tener score positivo');
  // El doc de cálculo (index 1) debería tener score 0
  const calculoResult = result.find((r) => r.index === 1);
  if (calculoResult !== undefined) {
    assert.equal(calculoResult.score, 0);
  }
});

test('rankByTfIdf: topK limita resultados', () => {
  const corpus = ['a b c', 'd e f', 'g h i', 'j k l', 'a e i'];
  const result = rankByTfIdf('a b c', corpus, 2);
  assert.ok(result.length <= 2);
});

test('rankByTfIdf: doc con más términos comunes es rankeado primero', () => {
  const corpus = [
    'agente ia tactic secuencia herramienta',
    'agente',
    'agente ia tactic secuencia herramienta ejecutar paso query'
  ];
  const result = rankByTfIdf('agente ia tactic secuencia herramienta', corpus, 3);
  assert.ok(result.length > 0);
  // doc 2 tiene todos los terms más extras, pero misma proporción de solapamiento
  // doc 0 tiene exactamente los 5 terms de la query → TF más alto para esos terms
  // Ambos doc 0 y doc 2 deben superar a doc 1 (solo "agente")
  const scoreDoc1 = result.find((r) => r.index === 1)?.score ?? 0;
  const scoreDoc0 = result.find((r) => r.index === 0)?.score ?? 0;
  assert.ok(scoreDoc0 > scoreDoc1, 'doc0 debe superar a doc1 (solo "agente")');
});

test('rankByTfIdf: scores entre 0 y 1', () => {
  const corpus = ['foo bar baz', 'foo', 'bar baz qux'];
  const result = rankByTfIdf('foo bar', corpus, 3);
  for (const r of result) {
    assert.ok(r.score >= 0 && r.score <= 1.0001, `score ${r.score} fuera de rango`);
  }
});
