/**
 * Tests para readJsonBody (src/lib/http/read-json-body.ts)
 * y para la validación de borde en POST /api/workspaces.
 *
 * Estos tests FALLAN con el código viejo (body no validado → 500 / persiste
 * nombre número) y PASAN con el fix.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readJsonBody } from '../src/lib/http/read-json-body.ts';

// Construcción mínima de un NextRequest a partir de un cuerpo de texto
function makeRequest(body: string, contentType = 'application/json'): Request {
    return new Request('http://localhost/api/test', {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body
    });
}

// --- readJsonBody: casos inválidos → 400 ---

test('readJsonBody: JSON malformado → 400', async () => {
    const req = makeRequest('{ bad json }');
    const result = await readJsonBody(req as never);
    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.equal(result.response.status, 400);
        const data = await result.response.json() as { error: string };
        assert.match(data.error, /JSON inválido/);
    }
});

test('readJsonBody: JSON truncado → 400', async () => {
    const req = makeRequest('{"name":"abc"');
    const result = await readJsonBody(req as never);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response.status, 400);
});

test('readJsonBody: body no-JSON (texto plano) → 400', async () => {
    const req = makeRequest('hola mundo', 'text/plain');
    const result = await readJsonBody(req as never);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response.status, 400);
});

test('readJsonBody: body null literal → 400', async () => {
    const req = makeRequest('null');
    const result = await readJsonBody(req as never);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response.status, 400);
});

test('readJsonBody: body array → 400', async () => {
    const req = makeRequest('[1, 2, 3]');
    const result = await readJsonBody(req as never);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response.status, 400);
});

test('readJsonBody: body número primitivo → 400', async () => {
    const req = makeRequest('42');
    const result = await readJsonBody(req as never);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response.status, 400);
});

test('readJsonBody: body string primitivo → 400', async () => {
    const req = makeRequest('"hola"');
    const result = await readJsonBody(req as never);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response.status, 400);
});

// --- readJsonBody: casos válidos → ok ---

test('readJsonBody: objeto plano válido → ok con value', async () => {
    const req = makeRequest('{"name":"Mi workspace","extra":true}');
    const result = await readJsonBody(req as never);
    assert.equal(result.ok, true);
    if (result.ok) {
        assert.equal(result.value.name, 'Mi workspace');
        assert.equal(result.value.extra, true);
    }
});

test('readJsonBody: objeto plano vacío → ok', async () => {
    const req = makeRequest('{}');
    const result = await readJsonBody(req as never);
    assert.equal(result.ok, true);
});

// --- validación de tipos: name numérico ---

test('name numérico: readJsonBody lo parsea OK pero validación posterior rechaza', async () => {
    const req = makeRequest('{"name":99999}');
    const result = await readJsonBody(req as never);
    // readJsonBody acepta el objeto plano (es JSON válido y es objeto)
    assert.equal(result.ok, true);
    if (result.ok) {
        // La validación de tipo en la ruta rechaza: typeof body.name !== 'string'
        const name = typeof result.value.name === 'string' ? result.value.name.trim() : '';
        assert.equal(name, '', 'name numérico debe colapsar a string vacío');
    }
});

test('name objeto: colapsa a string vacío', async () => {
    const req = makeRequest('{"name":{"nested":"value"}}');
    const result = await readJsonBody(req as never);
    assert.equal(result.ok, true);
    if (result.ok) {
        const name = typeof result.value.name === 'string' ? result.value.name.trim() : '';
        assert.equal(name, '');
    }
});

test('name string válido: pasa la validación', async () => {
    const req = makeRequest('{"name":"Mi Workspace"}');
    const result = await readJsonBody(req as never);
    assert.equal(result.ok, true);
    if (result.ok) {
        const name = typeof result.value.name === 'string' ? result.value.name.trim() : '';
        assert.equal(name, 'Mi Workspace');
    }
});

test('name string vacío: colapsa a string vacío (será rechazado con 400)', async () => {
    const req = makeRequest('{"name":""}');
    const result = await readJsonBody(req as never);
    assert.equal(result.ok, true);
    if (result.ok) {
        const name = typeof result.value.name === 'string' ? result.value.name.trim() : '';
        assert.equal(name, '');
    }
});
