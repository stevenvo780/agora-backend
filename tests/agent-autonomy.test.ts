/**
 * Tests de la heurística de autonomía: clasificación de turnos text-only del
 * agente (announce / confirm / final) y del clasificador de "solo pide permiso".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTextOnlyTurn,
  isPermissionOnlyMessage
} from '../src/lib/agora-ai/autonomy.ts';

test('announce: el agente dice que VA a crear documentos (bug reportado)', () => {
  assert.equal(
    classifyTextOnlyTurn('Perfecto. Ahora creo los 6 documentos de la unidad.'),
    'announce'
  );
});

test('announce: inglés "Let me create..."', () => {
  assert.equal(
    classifyTextOnlyTurn("Let me create the README and the config file now."),
    'announce'
  );
});

test('announce: "voy a implementar la función"', () => {
  assert.equal(
    classifyTextOnlyTurn('Entendido, voy a implementar la función de login.'),
    'announce'
  );
});

test('confirm: "¿continúo?"', () => {
  assert.equal(
    classifyTextOnlyTurn('He preparado el plan. ¿Continúo con la ejecución?'),
    'confirm'
  );
});

test('confirm: "¿quieres que los cree?"', () => {
  assert.equal(
    classifyTextOnlyTurn('Tengo los 6 títulos listos. ¿Quieres que los cree ahora?'),
    'confirm'
  );
});

test('confirm: inglés "Should I proceed?"', () => {
  assert.equal(
    classifyTextOnlyTurn('I have the outline ready. Should I proceed?'),
    'confirm'
  );
});

test('final: respuesta genuinamente terminada', () => {
  assert.equal(
    classifyTextOnlyTurn('Listo. Creé los 6 documentos y verifiqué que existen.'),
    'final'
  );
});

test('final: pregunta sustantiva con decisión real NO se auto-confirma', () => {
  // Una elección que requiere al usuario (clásico vs intuicionista) debe
  // surfacear como final, no auto-continuarse — el agente no puede decidir
  // por el usuario.
  assert.equal(
    classifyTextOnlyTurn('¿Prefieres perfil clásico o intuicionista para la formalización?'),
    'final'
  );
});

test('final: texto vacío', () => {
  assert.equal(classifyTextOnlyTurn(''), 'final');
});

test('isPermissionOnlyMessage: sin client cae a heurística (confirm → true)', async () => {
  const r = await isPermissionOnlyMessage('¿Continúo con la tarea?', null);
  assert.equal(r, true);
});

test('isPermissionOnlyMessage: sin client, texto final → false', async () => {
  const r = await isPermissionOnlyMessage('Terminé la tarea correctamente.', null);
  assert.equal(r, false);
});

test('isPermissionOnlyMessage: client responde SI', async () => {
  const r = await isPermissionOnlyMessage('Texto ambiguo', {
    classify: async () => 'SI'
  });
  assert.equal(r, true);
});

test('isPermissionOnlyMessage: client responde NO', async () => {
  const r = await isPermissionOnlyMessage('¿Continúo?', {
    classify: async () => 'NO'
  });
  assert.equal(r, false);
});

test('isPermissionOnlyMessage: client falla → cae a heurística', async () => {
  const r = await isPermissionOnlyMessage('¿Procedo con el borrado?', {
    classify: async () => { throw new Error('timeout'); }
  });
  assert.equal(r, true); // heurística detecta "¿procedo"
});

test('isPermissionOnlyMessage: respuesta de aux no parseable → heurística', async () => {
  const r = await isPermissionOnlyMessage('Terminé.', {
    classify: async () => 'no sé, tal vez'
  });
  // "no sé" empieza con NO → false
  assert.equal(r, false);
});
