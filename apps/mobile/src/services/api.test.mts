/**
 * Pruebas de resiliencia de la capa de red.
 *
 * Se comprueban los tres casos que dejan la aplicacion inservible sin dar la
 * cara: el servidor que no contesta, el telefono sin cobertura y la peticion
 * que se cancela sola al cambiar de pantalla.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

process.env.EXPO_PUBLIC_API_URL = 'http://servidor-de-prueba';

const { apiRequest, ApiError } = await import('./api.ts');

const fetchOriginal = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

test('el servidor que no responde acaba fallando, no esperando para siempre', async () => {
  // Un fetch que nunca resuelve por si solo: solo termina si alguien lo corta.
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const e = new Error('abortado');
        e.name = 'AbortError';
        reject(e);
      });
    })) as typeof fetch;

  const inicio = Date.now();
  const fallo = await apiRequest('/algo', { auth: false, timeoutMs: 120 }).catch((e) => e);

  assert.ok(fallo instanceof ApiError);
  assert.equal(fallo.code, 'timeout');
  assert.match(fallo.message, /tardando demasiado/);
  // Corta cuando toca, sin quedarse colgado.
  assert.ok(Date.now() - inicio < 2000);
});

test('sin cobertura se dice que falta conexion, no un error tecnico', async () => {
  globalThis.fetch = (() => Promise.reject(new TypeError('Network request failed'))) as typeof fetch;

  const fallo = await apiRequest('/algo', { auth: false }).catch((e) => e);

  assert.ok(fallo instanceof ApiError);
  assert.equal(fallo.code, 'network_error');
  assert.match(fallo.message, /Sin conexión/);
});

test('la cancelacion de quien llama no se disfraza de fallo del servidor', async () => {
  // Al salir de una pantalla se cancela lo que estuviera pidiendo. Eso no es
  // un fallo y no debe acabar en un aviso al usuario.
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const e = new Error('abortado');
        e.name = 'AbortError';
        reject(e);
      });
    })) as typeof fetch;

  const propia = new AbortController();
  const promesa = apiRequest('/algo', { auth: false, signal: propia.signal }).catch((e) => e);
  propia.abort();
  const fallo = await promesa;

  assert.equal(fallo.name, 'AbortError');
  assert.ok(!(fallo instanceof ApiError), 'no debe convertirse en error de tiempo agotado');
});

test('un error del servidor conserva su mensaje para poder explicarlo', async () => {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: { code: 'forbidden', message: 'No tienes acceso' } }), {
        status: 403,
      }),
    )) as typeof fetch;

  const fallo = await apiRequest('/algo', { auth: false }).catch((e) => e);

  assert.equal(fallo.status, 403);
  assert.equal(fallo.code, 'forbidden');
  assert.equal(fallo.message, 'No tienes acceso');
});

test('una respuesta sin contenido no revienta al intentar leerla', async () => {
  globalThis.fetch = (() => Promise.resolve(new Response(null, { status: 204 }))) as typeof fetch;

  const resultado = await apiRequest('/algo', { auth: false });
  assert.equal(resultado, undefined);
});
