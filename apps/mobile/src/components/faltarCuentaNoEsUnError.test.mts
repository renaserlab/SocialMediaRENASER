import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * NO TENER CUENTA NO ES UN FALLO DEL SISTEMA.
 *
 * EL FALLO. Un visitante sin sesion pulsaba el numero de reacciones y leia:
 *
 *     Ha ocurrido un error
 *     Falta el header Authorization Bearer.
 *     [Reintentar]
 *
 * Tres cosas mal en cuatro lineas. El mensaje es el del servidor, tal cual, y
 * habla de una cabecera HTTP. El icono es de alerta, como si algo se hubiera
 * roto. Y el boton invita a reintentar algo que no puede funcionar nunca: la
 * peticion volveria a dar 401 las veces que hiciera falta.
 *
 * LA CAUSA, y no era la pantalla. `useListaDePersonas` metia CUALQUIER fallo en
 * un `error: string` y tiraba el resto —incluido `ApiError.status`—, asi que
 * mas abajo ya no habia forma de distinguir «el servidor se cayo» de «hace
 * falta cuenta». Son dos situaciones distintas y solo una tiene salida.
 *
 * Y ADEMAS SE PREGUNTABA SIN NECESIDAD. La aplicacion sabe si hay sesion antes
 * de pedir nada; sin ella el servidor solo puede responder 401. Ese viaje de
 * ida y vuelta era el que llenaba la consola de rojo.
 *
 * Se mira el CODIGO FUENTE, como el resto de pruebas de esta carpeta: montar la
 * vista pediria un renderizador de React Native que este proyecto no tiene en
 * las pruebas.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

/** Quita los comentarios: lo que se busca tiene que estar en el codigo. */
function sinComentarios(texto: string): string {
  return texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const HOOK = sinComentarios(fuente('hooks/useListaDePersonas.ts'));
const LISTA = sinComentarios(fuente('components/PeopleList.tsx'));
const REACCIONES = sinComentarios(fuente('components/ListaDeReacciones.tsx'));

// ---------------------------------------------------------------------------
// 1. Las dos situaciones viajan separadas
// ---------------------------------------------------------------------------

test('el hook distingue «hace falta cuenta» de «algo fallo»', () => {
  assert.match(HOOK, /necesitaCuenta/);
  assert.match(HOOK, /return \{[^}]*error[^}]*necesitaCuenta/s);
});

test('un 401 o un 403 no se cuentan como error', () => {
  // Es el caso de la sesion caducada: el cliente creia tenerla y ya no vale.
  const captura = HOOK.slice(HOOK.indexOf('} catch (err)'));
  assert.match(captura, /err instanceof ApiError/);
  assert.match(captura, /err\.status === 401 \|\| err\.status === 403/);
  assert.match(captura, /setNecesitaCuenta\(true\)/);
});

test('el resto de fallos SIGUEN siendo errores', () => {
  // Si esto se perdiera, un 500 o una caida de red se leerian como «registrate»,
  // que manda a la persona a rellenar un formulario que no arregla nada.
  assert.match(HOOK, /else \{\s*setError\(/);
});

// ---------------------------------------------------------------------------
// 2. No se pregunta lo que ya se sabe
// ---------------------------------------------------------------------------

test('sin sesion NO se pide la lista al servidor', () => {
  const carga = HOOK.slice(HOOK.indexOf('const load'), HOOK.indexOf('} catch (err)'));
  const guarda = carga.indexOf("estadoDeSesion !== 'authenticated'");
  const peticion = carga.indexOf('await cargar()');
  assert.ok(guarda > 0, 'no se comprueba la sesion antes de pedir');
  assert.ok(peticion > guarda, 'se pide antes de comprobar si hay sesion');
});

test('mientras se averigua si hay sesion no se decide nada', () => {
  // En ese instante `status` no es 'authenticated' todavia. Sin esta guarda, a
  // quien SI tiene cuenta se le ofreceria registrarse durante el arranque.
  assert.match(HOOK, /estadoDeSesion === 'loading'/);
});

// ---------------------------------------------------------------------------
// 3. Lo que ve quien no tiene cuenta
// ---------------------------------------------------------------------------

test('se ofrece crear la cuenta, no reintentar', () => {
  const bloque = LISTA.slice(LISTA.indexOf('if (necesitaCuenta)'));
  assert.match(bloque, /state="empty"/, 'sigue pintandose como un error');
  assert.match(bloque, /actionLabel=\{t\('auth\.signUp'\)\}/);
  assert.match(bloque, /router\.push\('\/register'/);
});

test('el aviso se pinta ANTES que el error', () => {
  // Una sesion caducada llega por los dos caminos a la vez; si ganara el error,
  // se volveria a leer el mensaje tecnico del servidor.
  const cuenta = LISTA.indexOf('if (necesitaCuenta)');
  const error = LISTA.indexOf('if (error)');
  assert.ok(cuenta > 0 && cuenta < error, 'el error tapa al aviso de cuenta');
});

test('el texto dice para que hace falta la cuenta', () => {
  // «Necesitas una cuenta» a secas no explica nada; el motivo es lo que hace
  // que la persona entienda que no se ha roto nada.
  assert.match(LISTA, /t\('auth\.needAccount', \{\s*motivo/);
  assert.match(REACCIONES, /motivoDeCuenta=\{t\('auth\.reasonSeeReactions'\)\}/);
});

test('ningun texto de la interfaz habla de cabeceras HTTP', () => {
  for (const [nombre, archivo] of [
    ['la lista', LISTA],
    ['las reacciones', REACCIONES],
  ] as const) {
    assert.doesNotMatch(archivo, /Authorization|Bearer|401|403/, `${nombre} filtra detalles HTTP`);
  }
});
