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

test('un servidor que falla sin explicarse no imprime el codigo en pantalla', async () => {
  // Produccion devuelve «Internal Server Error» en texto plano, sin JSON. Antes
  // el respaldo era `Error 500` y ese literal se pintaba en el feed.
  globalThis.fetch = (() =>
    Promise.resolve(new Response('Internal Server Error', { status: 500 }))) as typeof fetch;

  const fallo = await apiRequest('/algo', { auth: false }).catch((e) => e);

  assert.equal(fallo.status, 500, 'el estado sigue disponible para depurar');
  assert.doesNotMatch(fallo.message, /500|Error \d/);
  assert.match(fallo.message, /no está disponible/i);
});

test('la sesion caducada se explica, no se numera', async () => {
  globalThis.fetch = (() => Promise.resolve(new Response(null, { status: 401 }))) as typeof fetch;

  const fallo = await apiRequest('/algo', { auth: false }).catch((e) => e);

  assert.equal(fallo.status, 401);
  assert.match(fallo.message, /sesión caducó/i);
});

/*
  Las dos siguientes fijan una decision de RENDIMIENTO, no de comportamiento.

  `Content-Type: application/json` no esta en la lista segura de CORS: en el
  navegador obliga a una peticion `OPTIONS` previa. El muro se puede leer sin
  cuenta, asi que en la primera pantalla que ve alguien sin registrarse cada
  GET costaba dos viajes en vez de uno. Si alguien vuelve a ponerla siempre,
  esto se pone rojo.
*/
test('un GET sin cuerpo no manda Content-Type (evita el preflight de CORS)', async () => {
  let enviadas: Record<string, string> = {};
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    enviadas = (init?.headers ?? {}) as Record<string, string>;
    return Promise.resolve(new Response('{}', { status: 200 }));
  }) as typeof fetch;

  await apiRequest('/muro', { auth: false });

  assert.equal(
    enviadas['Content-Type'],
    undefined,
    'un GET sin cuerpo no necesita declarar el formato de algo que no manda',
  );
});

test('una peticion CON cuerpo si declara que manda JSON', async () => {
  let enviadas: Record<string, string> = {};
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    enviadas = (init?.headers ?? {}) as Record<string, string>;
    return Promise.resolve(new Response('{}', { status: 200 }));
  }) as typeof fetch;

  await apiRequest('/muro', {
    auth: false,
    method: 'POST',
    body: JSON.stringify({ texto: 'hola' }),
  });

  assert.equal(enviadas['Content-Type'], 'application/json');
});

test('ya no existe una llamada de arranque para despertar el servidor', async () => {
  // El backend en AWS no duerme. `warmUpApi()` existia para el plan gratuito
  // de Render y hoy solo seria una peticion mas compitiendo con la del feed
  // justo en el arranque.
  const modulo = await import('./api.ts');
  assert.equal(
    'warmUpApi' in modulo,
    false,
    'warmUpApi volvio: era una suposicion sobre Render, no sobre AWS',
  );
});
