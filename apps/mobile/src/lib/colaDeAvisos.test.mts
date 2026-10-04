import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DURACION_DEL_AVISO,
  MAXIMO_EN_ESPERA,
  avanzarCola,
  claveDelAviso,
  duracionDelAviso,
  encolarAviso,
  retirarAvisos,
  type AvisoEnCola,
  type TipoDeAviso,
} from './colaDeAvisos.ts';

/**
 * LA COLA DE AVISOS, EJECUTADA.
 *
 * Es lo que impide que dos avisos se pisen en pantalla, que el mismo se repita
 * cinco veces y que un error se pierda porque justo después llegó un
 * «guardado». El componente solo pinta la cabeza de lo que sale de aquí.
 */

let siguienteId = 0;
function aviso(tipo: TipoDeAviso, clave: string): AvisoEnCola {
  return { id: ++siguienteId, tipo, clave };
}

const claves = (cola: readonly AvisoEnCola[]) => cola.map((a) => a.clave);

test('el primero entra y es el visible', () => {
  const cola = encolarAviso([], aviso('exito', 'a'));
  assert.deepEqual(claves(cola), ['a']);
});

test('una confirmación sustituye a la confirmación que se está viendo', () => {
  // «Guardado» y, medio segundo después, «Quitado»: lo último es lo que cuenta.
  let cola = encolarAviso([], aviso('exito', 'guardado'));
  cola = encolarAviso(cola, aviso('exito', 'quitado'));
  assert.deepEqual(claves(cola), ['quitado']);
});

test('un error no se pierde por una confirmación que llega después', () => {
  let cola = encolarAviso([], aviso('error', 'sin-red'));
  cola = encolarAviso(cola, aviso('exito', 'guardado'));
  assert.deepEqual(claves(cola), ['sin-red', 'guardado'], 'el error sigue visible; lo otro espera');
});

test('una confirmación visible no la pisa una notificación: se encola', () => {
  let cola = encolarAviso([], aviso('exito', 'guardado'));
  cola = encolarAviso(cola, aviso('notificacion', 'conv:1'));
  assert.deepEqual(claves(cola), ['guardado', 'conv:1']);
});

test('lo mismo no se repite: ocupa el sitio del que ya estaba', () => {
  let cola = encolarAviso([], aviso('error', 'sin-red'));
  cola = encolarAviso(cola, aviso('notificacion', 'conv:1'));
  cola = encolarAviso(cola, aviso('notificacion', 'conv:2'));
  const repetido = aviso('notificacion', 'conv:1');
  cola = encolarAviso(cola, repetido);
  assert.deepEqual(claves(cola), ['sin-red', 'conv:1', 'conv:2'], 'ni duplica ni cambia el orden');
  assert.equal(cola[1]?.id, repetido.id, 'pero es el nuevo: trae el texto más reciente');
});

test('repetir el que se está viendo lo renueva en su sitio', () => {
  let cola = encolarAviso([], aviso('notificacion', 'conv:1'));
  const otra = aviso('notificacion', 'conv:1');
  cola = encolarAviso(cola, otra);
  assert.equal(cola.length, 1);
  assert.equal(cola[0]?.id, otra.id, 'id nuevo: el componente se remonta y reinicia su reloj');
});

test('la espera tiene tope y se cae el que más lleva, nunca el visible', () => {
  let cola = encolarAviso([], aviso('error', 'visible'));
  for (let i = 1; i <= MAXIMO_EN_ESPERA + 2; i += 1) {
    cola = encolarAviso(cola, aviso('notificacion', `n${i}`));
  }
  assert.equal(cola.length, 1 + MAXIMO_EN_ESPERA);
  assert.equal(cola[0]?.clave, 'visible');
  assert.deepEqual(claves(cola).slice(1), ['n3', 'n4', 'n5'], 'quedan los más recientes');
});

test('avanzar quita al visible y pasa el siguiente', () => {
  const primero = aviso('error', 'a');
  let cola = encolarAviso([], primero);
  cola = encolarAviso(cola, aviso('notificacion', 'b'));
  cola = avanzarCola(cola, primero.id);
  assert.deepEqual(claves(cola), ['b']);
});

test('el cierre de un aviso ya sustituido no se lleva al que lo sustituyó', () => {
  // El visible se está despidiendo y en ese momento entra otra confirmación.
  const viejo = aviso('exito', 'guardado');
  let cola = encolarAviso([], viejo);
  cola = encolarAviso(cola, aviso('exito', 'quitado'));
  cola = avanzarCola(cola, viejo.id);
  assert.deepEqual(claves(cola), ['quitado'], 'sigue ahí: el cierre era del anterior');
});

test('avanzar una cola vacía no rompe nada', () => {
  assert.deepEqual(avanzarCola([], 7), []);
});

test('retirar quita los de una clave, estén donde estén', () => {
  let cola = encolarAviso([], aviso('error', 'sin-red'));
  cola = encolarAviso(cola, aviso('notificacion', 'conv:1'));
  cola = encolarAviso(cola, aviso('notificacion', 'conv:2'));
  cola = retirarAvisos(cola, (clave) => clave === 'conv:1');
  assert.deepEqual(claves(cola), ['sin-red', 'conv:2']);
});

test('la clave por defecto es el tipo y el texto', () => {
  assert.equal(claveDelAviso('exito', 'Guardado'), 'exito:Guardado');
  assert.equal(claveDelAviso('notificacion', 'Hola', 'conv:9'), 'conv:9');
});

test('lo que pide decidir dura más que lo que solo informa', () => {
  assert.ok(DURACION_DEL_AVISO.error > DURACION_DEL_AVISO.exito);
  assert.ok(DURACION_DEL_AVISO.reversible > DURACION_DEL_AVISO.exito);
  // Con acción hay que dar tiempo a leer Y a llegar con el dedo.
  assert.equal(duracionDelAviso('exito', true), DURACION_DEL_AVISO.reversible);
  assert.equal(duracionDelAviso('exito', false), DURACION_DEL_AVISO.exito);
  assert.equal(duracionDelAviso('exito', false, 9000), 9000, 'la pedida manda');
});

// ---------------------------------------------------------------------------
// El host usa esta cola, y solo esta
// ---------------------------------------------------------------------------

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

test('el host pinta la cabeza de la cola y nada más', () => {
  const host = fuente('components/ToastHost.tsx');
  assert.match(host, /encolarAviso\(actual, aviso\)/);
  assert.match(host, /avanzarCola\(actual, visible\.id\)/);
  assert.match(host, /const visible = cola\[0\];/);
  // Un solo <Toast: nunca dos a la vez.
  assert.equal(host.match(/<Toast\b/g)?.length, 1);
});

test('el aviso se puede quitar con el dedo y respeta «reducir movimiento»', () => {
  const toast = fuente('components/Toast.tsx');
  assert.match(toast, /Gesture\.Pan\(\)/);
  assert.match(toast, /useReducedMotion\(\)/);
  assert.match(toast, /useSafeAreaInsets\(\)\.top/, 'debajo de la muesca');
  assert.match(toast, /announceForAccessibility\(/, 'quien no ve la pantalla también se entera');
});
