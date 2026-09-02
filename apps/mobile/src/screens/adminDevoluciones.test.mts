import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * RESOLVER UNA DEVOLUCION MUEVE DINERO DE OTRA PERSONA.
 *
 * De ahi las tres cosas que esta prueba fija, y que son las tres que se
 * rompen solas cuando alguien añade «una accion mas»:
 *
 *  1. HAY HISTORIAL. Una bandeja sin el expediente de estados es una lista de
 *     botones: no se puede saber si alguien ya tomo la solicitud, ni por que se
 *     rechazo la anterior.
 *
 *  2. NO SE PUEDE PULSAR DOS VECES. Ni el mismo boton dos veces ni dos botones
 *     distintos a la vez —aprobar y rechazar en el mismo segundo es peor que
 *     aprobar dos veces—, asi que mientras se envia se apagan TODOS.
 *
 *  3. SE AVISA ANTES, con palabras. Y rechazar exige motivo: sin el, quien
 *     pidio la devolucion se queda sin nada que leer.
 *
 * Se mira el CODIGO FUENTE, como el resto de pruebas de esta carpeta.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

function sinComentarios(texto: string): string {
  return texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const BANDEJA = sinComentarios(fuente('screens/AdminDevolucionesScreen.tsx'));
const REPO = sinComentarios(fuente('repositories/OwnerRepository.ts'));

// ---------------------------------------------------------------------------
// 1. El expediente: historial de estados
// ---------------------------------------------------------------------------

test('el detalle pinta el HISTORIAL de estados', () => {
  assert.match(BANDEJA, /devolucionesAdmin\.historial/);
  assert.match(BANDEJA, /solicitud\.history\.map/);
  assert.match(BANDEJA, /devolucionesAdmin\.estado\.\$\{paso\.status\}/);
});

test('el historial viaja en el detalle, no se reconstruye aqui', () => {
  assert.match(REPO, /history: \(dto\.history \?\? \[\]\)\.map/);
  assert.match(REPO, /refund-requests\/\$\{id\}`/);
});

test('tras una accion se RELEE el expediente', () => {
  // La respuesta de la accion puede no traer el historial, y el historial es
  // justo lo que hay que ver despues de actuar.
  const ejecutar = BANDEJA.slice(BANDEJA.indexOf('const ejecutar'));
  const accion = ejecutar.indexOf('OwnerRepository.accion');
  const relectura = ejecutar.indexOf('OwnerRepository.solicitud(solicitud.id)');
  assert.ok(accion > 0 && relectura > accion, 'no se vuelve a leer la solicitud');
});

// ---------------------------------------------------------------------------
// 2. Doble accion
// ---------------------------------------------------------------------------

test('el cerrojo es sincrono, no el estado', () => {
  // `enviando` no esta puesto hasta el siguiente render: dos toques rapidos
  // caben de sobra en ese hueco.
  assert.match(BANDEJA, /if \(enviandoRef\.current\) return;/);
  const ejecutar = BANDEJA.slice(BANDEJA.indexOf('const ejecutar'));
  const cerrojo = ejecutar.indexOf('enviandoRef.current = true');
  const peticion = ejecutar.indexOf('OwnerRepository.accion');
  assert.ok(cerrojo > 0 && peticion > cerrojo, 'se envia antes de cerrar el paso');
});

test('mientras se envia se apagan TODOS los botones, no solo el pulsado', () => {
  assert.match(BANDEJA, /const ocupado = enviando !== null;/);
  assert.match(BANDEJA, /disabled=\{ocupado\}/);
  // Y se ANUNCIA apagado: la opacidad no la ve un lector de pantalla.
  assert.match(BANDEJA, /accessibilityState=\{\{ disabled: ocupado \}\}/);
});

test('el cerrojo se suelta pase lo que pase', () => {
  assert.match(BANDEJA, /finally \{[\s\S]{0,120}enviandoRef\.current = false/);
});

// ---------------------------------------------------------------------------
// 3. Avisos y motivo obligatorio
// ---------------------------------------------------------------------------

test('las acciones financieras avisan ANTES de ejecutarse', () => {
  for (const accion of ['approve', 'retry', 'reconcile']) {
    assert.match(REPO, new RegExp(`'${accion}'`), `${accion} no esta declarada`);
  }
  assert.match(REPO, /ACCIONES_FINANCIERAS/);
  assert.match(BANDEJA, /devolucionesAdmin\.avisoAprobar/);
  assert.match(BANDEJA, /devolucionesAdmin\.avisoReintentar/);
  assert.match(BANDEJA, /devolucionesAdmin\.avisoReconciliar/);
  const ejecutar = BANDEJA.slice(BANDEJA.indexOf('const ejecutar'));
  const confirmacion = ejecutar.indexOf('await confirm(');
  const peticion = ejecutar.indexOf('OwnerRepository.accion');
  assert.ok(confirmacion > 0 && peticion > confirmacion, 'se actua antes de avisar');
});

test('rechazar SIN motivo no llega al servidor', () => {
  assert.match(BANDEJA, /accion === 'reject' && motivo === ''/);
  const ejecutar = BANDEJA.slice(BANDEJA.indexOf('const ejecutar'));
  const guarda = ejecutar.indexOf("accion === 'reject' && motivo === ''");
  const peticion = ejecutar.indexOf('OwnerRepository.accion');
  assert.ok(guarda > 0 && peticion > guarda, 'se rechaza sin comprobar el motivo');
});

test('el motivo se manda en el cuerpo, como pide el contrato', () => {
  assert.match(REPO, /body: JSON\.stringify\(\{ notes: texto \}\)/);
});

// ---------------------------------------------------------------------------
// 4. Permisos y botones vivos
// ---------------------------------------------------------------------------

test('un 403 se dice, no se disfraza de bandeja vacia', () => {
  // Esconder botones no es un permiso: quien entra igualmente tiene que leer
  // por que no puede, no una lista vacia que parece «no hay solicitudes».
  assert.match(BANDEJA, /esProhibido\(e\)/);
  assert.match(BANDEJA, /devolucionesAdmin\.sinPermiso/);
});

test('cada estado ofrece solo las acciones que tienen sentido en el', () => {
  // Un boton que el servidor va a rechazar es un boton muerto.
  assert.match(BANDEJA, /ACCIONES_POR_ESTADO/);
  assert.match(BANDEJA, /rejected: \[\]/);
  assert.match(BANDEJA, /cancelled: \[\]/);
});

test('todas las acciones del contrato estan cableadas a un boton', () => {
  for (const accion of ['tomar', 'aprobar', 'rechazar', 'cancelar', 'reintentar', 'reconciliar']) {
    assert.match(BANDEJA, new RegExp(`'${accion}'`), `falta la etiqueta de ${accion}`);
  }
  assert.match(BANDEJA, /void ejecutar\(accion\)/);
});

test('la lista se pagina y se filtra por estado contra el servidor', () => {
  assert.match(BANDEJA, /offset: solicitudes\.length/);
  assert.match(BANDEJA, /status: estado/);
  assert.match(BANDEJA, /onEndReached/);
});
