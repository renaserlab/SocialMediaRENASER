import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  ESTILOS_DE_ROTULO,
  ESTILO_POR_OMISION,
  MAXIMO_DE_ROTULO,
  PRESENTACION_POR_OMISION,
  accionesDeMensaje,
  avisoDeDestacado,
  claveDelFalloDeDestacado,
  claveDelRotulo,
  crearRepaso,
  destacadoVacio,
  diceAlgo,
  juzgarRotulo,
  largoDelRotulo,
  leerDestacado,
  leerRotulo,
  limpiarRotulo,
  pareceUnMensaje,
  sinDestacado,
  topicoDeDestacado,
} from './destacado.ts';

/*
  Lo destacado de un directo: el mensaje fijado y el rotulo de quien emite.

  Tres mitades. Las reglas, ejecutadas. El reparto de las preguntas al servidor,
  con un reloj de mentira y varios avisos a la vez. Y la custodia de que la
  aplicacion y el servidor dicen lo mismo —estilos, tope, codigos— y de que la
  pantalla usa estas reglas en vez de copiarlas.
*/

const leer = (ruta: string) =>
  readFileSync(new URL(ruta, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const sinComentarios = (fuente: string) =>
  fuente
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const aMensaje = (dto: { id: string; body: string }) => ({ id: dto.id, cuerpo: dto.body });

/* ------------------------------------------------------- limpiar y medir --- */

test('el rotulo se queda en una linea y sin relleno', () => {
  assert.equal(limpiarRotulo('  Hoy:\n\n  taller\tde   pan  '), 'Hoy: taller de pan');
  assert.equal(limpiarRotulo('a b c'), 'a b c');
  assert.equal(limpiarRotulo('a  b'), 'a b');
});

test('lo que ya estaba limpio no se toca, en ningun alfabeto', () => {
  for (const texto of ['Hola', '¡Sorteo a las 8!', 'Ñandú 100 %', '日本語のテキスト', 'مرحبا']) {
    assert.equal(limpiarRotulo(texto), texto);
    assert.equal(juzgarRotulo(texto), 'vale');
  }
});

test('se quitan los invisibles que vacian el texto o le dan la vuelta', () => {
  // U+202E hace que lo que sigue se lea de derecha a izquierda.
  assert.equal(limpiarRotulo('‮Sorteo'), 'Sorteo');
  assert.equal(limpiarRotulo('Ho​la'), 'Hola');
  assert.equal(limpiarRotulo('﻿Hola'), 'Hola');
});

test('un emoji compuesto no se rompe: conserva su unidor', () => {
  const familia = '\u{1f468}‍\u{1f469}‍\u{1f467}';
  assert.equal(limpiarRotulo(`Para todos ${familia}`), `Para todos ${familia}`);
});

test('se cuenta por caracteres, como el servidor, no por unidades de UTF-16', () => {
  const corazones = '\u{1f499}'.repeat(MAXIMO_DE_ROTULO);
  assert.equal(corazones.length, MAXIMO_DE_ROTULO * 2);
  assert.equal(largoDelRotulo(corazones), MAXIMO_DE_ROTULO);
  // Ochenta emojis caben; con `.length` se habrian rechazado.
  assert.equal(juzgarRotulo(corazones), 'vale');
  assert.equal(juzgarRotulo(corazones + '\u{1f499}'), 'largo');
});

test('el tope se mide DESPUES de limpiar', () => {
  assert.equal(juzgarRotulo('a'.repeat(MAXIMO_DE_ROTULO)), 'vale');
  assert.equal(juzgarRotulo('a'.repeat(MAXIMO_DE_ROTULO + 1)), 'largo');
  const conRelleno = `   ${Array(16).fill('hola').join('    ')}   \n\n`;
  assert.ok(conRelleno.length > MAXIMO_DE_ROTULO);
  assert.equal(juzgarRotulo(conRelleno), 'vale');
});

test('un texto que no dice nada no se manda', () => {
  for (const texto of ['', '   ', '\n\n\t', '​​', '‍‍‍', '́́']) {
    assert.equal(juzgarRotulo(texto), 'vacio', JSON.stringify(texto));
  }
  assert.equal(diceAlgo('‍'), false);
  assert.equal(diceAlgo('!'), true);
  assert.equal(diceAlgo('\u{1f499}'), true);
});

/* ------------------------------------------------------------------ leer --- */

test('la respuesta vacia del servidor se lee como «nada destacado»', () => {
  assert.deepEqual(
    leerDestacado({ pinned: null, banner: null, can_manage: true }, aMensaje),
    // Un servidor sin la 0114 no dice `banner_layout`: no se puede mover.
    { fijado: null, rotulo: null, puedeGestionar: true, rotuloEditable: false },
  );
  assert.deepEqual(destacadoVacio(), {
    fijado: null,
    rotulo: null,
    puedeGestionar: false,
    rotuloEditable: false,
  });
});

test('se leen el mensaje fijado y el rotulo', () => {
  const leido = leerDestacado(
    {
      pinned: { id: 'm1', session_id: 's', user_id: 'u', body: 'hola', hidden: false },
      banner: { text: 'Sorteo a las 8', style: 'pulse', set_at: '2026-10-09T10:00:00Z' },
      can_manage: false,
    },
    aMensaje,
  );
  assert.deepEqual(leido, {
    fijado: { id: 'm1', cuerpo: 'hola' },
    rotulo: {
      texto: 'Sorteo a las 8',
      estilo: 'pulse',
      puestoEnIso: '2026-10-09T10:00:00Z',
      // Un rótulo de antes de la 0114 se pinta como siempre.
      presentacion: PRESENTACION_POR_OMISION,
    },
    puedeGestionar: false,
    rotuloEditable: false,
  });
});

test('un 200 que no es lo destacado es un contrato roto, no «no hay nada»', () => {
  for (const bruto of [null, undefined, 'hola', 3, [], {}, { guests: [] }, { pinned: null }]) {
    assert.equal(leerDestacado(bruto, aMensaje), null, JSON.stringify(bruto));
  }
});

test('`can_manage` solo vale si es exactamente true', () => {
  for (const valor of ['true', 1, {}, null, undefined]) {
    const leido = leerDestacado({ pinned: null, banner: null, can_manage: valor }, aMensaje);
    assert.equal(leido?.puedeGestionar, false);
  }
});

test('un estilo que esta version no conoce se pinta como el de siempre', () => {
  assert.equal(leerRotulo({ text: 'Hola', style: 'explosion' })?.estilo, ESTILO_POR_OMISION);
  assert.equal(leerRotulo({ text: 'Hola' })?.estilo, 'slide');
  assert.equal(leerRotulo({ text: 'Hola', style: 'ticker' })?.estilo, 'ticker');
});

test('un rotulo sin texto no es un rotulo', () => {
  for (const bruto of [null, [], {}, { text: '' }, { text: '   ' }, { text: 4 }]) {
    assert.equal(leerRotulo(bruto), null, JSON.stringify(bruto));
  }
});

test('un mensaje escondido o a medias no se pinta fijado', () => {
  const bueno = { id: 'm1', user_id: 'u', body: 'hola' };
  assert.equal(pareceUnMensaje(bueno), true);
  assert.equal(pareceUnMensaje({ ...bueno, hidden: true }), false);
  assert.equal(pareceUnMensaje({ ...bueno, body: '' }), false);
  assert.equal(pareceUnMensaje({ ...bueno, id: '' }), false);
  assert.equal(pareceUnMensaje({ id: 'm1', body: 'hola' }), false);
  assert.equal(pareceUnMensaje(null), false);

  const leido = leerDestacado(
    { pinned: { ...bueno, hidden: true }, banner: null, can_manage: true },
    aMensaje,
  );
  assert.equal(leido?.fijado, null);
});

/* -------------------------------------------------- la entrada del rotulo --- */

test('releer el mismo rotulo no lo hace entrar otra vez', () => {
  const rotulo = { texto: 'Hola', estilo: 'slide' as const, puestoEnIso: '2026-10-09T10:00:00Z' };
  assert.equal(claveDelRotulo(rotulo), claveDelRotulo({ ...rotulo }));
});

test('otro texto, otro estilo u otra fecha SI son otro rotulo', () => {
  const rotulo = { texto: 'Hola', estilo: 'slide' as const, puestoEnIso: '2026-10-09T10:00:00Z' };
  const clave = claveDelRotulo(rotulo);
  assert.notEqual(claveDelRotulo({ ...rotulo, texto: 'Adios' }), clave);
  assert.notEqual(claveDelRotulo({ ...rotulo, estilo: 'pulse' }), clave);
  // Quitarlo y volver a poner el mismo texto: cambia su fecha.
  assert.notEqual(claveDelRotulo({ ...rotulo, puestoEnIso: '2026-10-09T10:05:00Z' }), clave);
  assert.equal(claveDelRotulo(null), '');
});

/* ------------------------------------------------- acciones de un mensaje --- */

test('quien mira no tiene menu', () => {
  assert.deepEqual(
    accionesDeMensaje({ puedeModerar: false, puedeDestacar: true, mensajeId: 'm1', fijadoId: null }),
    [],
  );
});

test('quien modera puede fijar y ocultar; ocultar va lo ultimo', () => {
  assert.deepEqual(
    accionesDeMensaje({ puedeModerar: true, puedeDestacar: true, mensajeId: 'm1', fijadoId: null }),
    ['fijar', 'ocultar'],
  );
});

test('el mensaje que ya esta fijado ofrece soltarlo, no fijarlo otra vez', () => {
  assert.deepEqual(
    accionesDeMensaje({ puedeModerar: true, puedeDestacar: true, mensajeId: 'm1', fijadoId: 'm1' }),
    ['soltar', 'ocultar'],
  );
  // Con otro fijado, este se puede fijar (lo sustituye).
  assert.deepEqual(
    accionesDeMensaje({ puedeModerar: true, puedeDestacar: true, mensajeId: 'm2', fijadoId: 'm1' }),
    ['fijar', 'ocultar'],
  );
});

test('sin la migracion 0099 solo queda ocultar, como antes', () => {
  assert.deepEqual(
    accionesDeMensaje({ puedeModerar: true, puedeDestacar: false, mensajeId: 'm1', fijadoId: null }),
    ['ocultar'],
  );
});

/* ---------------------------------------------------------------- avisos --- */

test('el topico es el mismo en todos los telefonos de la sala', () => {
  assert.equal(topicoDeDestacado('abc'), 'live-destacado:abc');
  assert.equal(topicoDeDestacado('abc'), topicoDeDestacado('abc'));
  assert.notEqual(topicoDeDestacado('abc'), topicoDeDestacado('abd'));
});

test('el aviso no lleva ni el texto ni el mensaje', () => {
  assert.deepEqual(avisoDeDestacado(), { v: 1 });
});

/* ------------------------------------------------- cuando se pregunta ------ */

function reloj() {
  let ahora = 0;
  let siguiente = 1;
  const pendientes = new Map<number, { cuando: number; fn: () => void }>();
  return {
    ahora: () => ahora,
    programar(fn: () => void, ms: number) {
      const id = siguiente++;
      pendientes.set(id, { cuando: ahora + ms, fn });
      return () => {
        pendientes.delete(id);
      };
    },
    avanzar(ms: number) {
      const hasta = ahora + ms;
      for (;;) {
        const proximo = [...pendientes.entries()]
          .filter(([, p]) => p.cuando <= hasta)
          .sort((a, b) => a[1].cuando - b[1].cuando)[0];
        if (!proximo) break;
        pendientes.delete(proximo[0]);
        ahora = proximo[1].cuando;
        proximo[1].fn();
      }
      ahora = hasta;
    },
    enCola: () => pendientes.size,
  };
}

/** Una lectura que se resuelve cuando la prueba lo dice. */
function lector() {
  const abiertas: Array<() => void> = [];
  let veces = 0;
  return {
    leer: () =>
      new Promise<void>((resolver) => {
        veces++;
        abiertas.push(resolver);
      }),
    veces: () => veces,
    enVuelo: () => abiertas.length,
    async responder() {
      abiertas.shift()?.();
      // Deja correr el `.then` del repaso.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

test('el primer aviso pregunta en el acto', () => {
  const r = reloj();
  const l = lector();
  const repaso = crearRepaso({ leer: l.leer, esperaMs: 2_000, programar: r.programar, ahora: r.ahora });
  repaso.pedir();
  assert.equal(l.veces(), 1);
});

test('una rafaga de avisos se junta en UNA pregunta al final de la espera', async () => {
  const r = reloj();
  const l = lector();
  const repaso = crearRepaso({ leer: l.leer, esperaMs: 2_000, programar: r.programar, ahora: r.ahora });

  repaso.pedir();
  await l.responder();
  for (let i = 0; i < 50; i++) {
    r.avanzar(20);
    repaso.pedir();
  }
  // Cincuenta avisos en un segundo: todavia ninguna pregunta de mas.
  assert.equal(l.veces(), 1);
  r.avanzar(1_000);
  assert.equal(l.veces(), 2);
  await l.responder();
  r.avanzar(10_000);
  assert.equal(l.veces(), 2);
  assert.equal(r.enCola(), 0);
});

test('cien avisos por segundo durante un minuto: una pregunta cada dos segundos', async () => {
  const r = reloj();
  const l = lector();
  const repaso = crearRepaso({ leer: l.leer, esperaMs: 2_000, programar: r.programar, ahora: r.ahora });
  for (let i = 0; i < 6_000; i++) {
    repaso.pedir();
    while (l.enVuelo() > 0) await l.responder();
    r.avanzar(10);
  }
  assert.ok(l.veces() <= 31, `preguntó ${l.veces()} veces`);
  assert.ok(l.veces() >= 29, `preguntó ${l.veces()} veces`);
});

test('nunca hay dos preguntas a la vez, y lo que llega en vuelo no se pierde', async () => {
  const r = reloj();
  const l = lector();
  const repaso = crearRepaso({ leer: l.leer, esperaMs: 2_000, programar: r.programar, ahora: r.ahora });

  repaso.pedir();
  r.avanzar(5_000); // la respuesta tarda mas que la espera
  repaso.pedir();
  repaso.pedir();
  assert.equal(l.veces(), 1);
  assert.equal(l.enVuelo(), 1);

  // Al volver la primera, se pregunta otra vez: lo que cambio mientras tanto
  // no venia en aquella respuesta.
  await l.responder();
  assert.equal(l.veces(), 2);
  assert.equal(l.enVuelo(), 1);
});

test('entrar en la sala pregunta ya, sin esperar turno', async () => {
  const r = reloj();
  const l = lector();
  const repaso = crearRepaso({ leer: l.leer, esperaMs: 2_000, programar: r.programar, ahora: r.ahora });
  repaso.pedir();
  await l.responder();
  r.avanzar(100);
  repaso.pedir(); // esta se queda esperando
  repaso.ahoraMismo(); // y esta no
  assert.equal(l.veces(), 2);
  // La que esperaba se cancela: no hay una tercera detras.
  assert.equal(r.enCola(), 0);
});

test('una lectura que falla no deja el repaso atascado', async () => {
  const r = reloj();
  let veces = 0;
  const repaso = crearRepaso({
    leer: () => {
      veces++;
      return Promise.reject(new Error('sin red'));
    },
    esperaMs: 2_000,
    programar: r.programar,
    ahora: r.ahora,
  });
  repaso.pedir();
  await Promise.resolve();
  await Promise.resolve();
  r.avanzar(2_000);
  repaso.pedir();
  assert.equal(veces, 2);
});

test('al salir de la sala no queda ninguna pregunta programada', async () => {
  const r = reloj();
  const l = lector();
  const repaso = crearRepaso({ leer: l.leer, esperaMs: 2_000, programar: r.programar, ahora: r.ahora });
  repaso.pedir();
  await l.responder();
  repaso.pedir();
  assert.equal(r.enCola(), 1);
  repaso.destruir();
  assert.equal(r.enCola(), 0);
  r.avanzar(10_000);
  repaso.pedir();
  repaso.ahoraMismo();
  assert.equal(l.veces(), 1);
});

/* ---------------------------------------------------------------- fallos --- */

test('cada codigo del servidor tiene su texto, y lo demas se cuenta en general', () => {
  assert.equal(claveDelFalloDeDestacado('live_spotlight_closed'), 'live.spotlightClosed');
  assert.equal(claveDelFalloDeDestacado('live_spotlight_rate_limited'), 'live.spotlightTooFast');
  assert.equal(claveDelFalloDeDestacado('live_message_hidden'), 'live.pinHidden');
  assert.equal(claveDelFalloDeDestacado('otra_cosa'), null);
  assert.equal(claveDelFalloDeDestacado('toString'), null);
  assert.equal(claveDelFalloDeDestacado(null), null);
});

test('solo «no esta montado» esconde las opciones; la red no', () => {
  assert.equal(sinDestacado({ status: 503, code: 'live_spotlight_not_available' }), true);
  assert.equal(sinDestacado({ status: 404 }), true);
  assert.equal(sinDestacado({ status: 500 }), false);
  assert.equal(sinDestacado({ status: 0 }), false);
  assert.equal(sinDestacado({ status: 409, code: 'live_spotlight_closed' }), false);
  assert.equal(sinDestacado(null), false);
});

/* -------------------------------------------- la aplicacion y el servidor --- */

const servidor = leer('../../../api/app/modules/live/destacado.py');
const rutas = leer('../../../api/app/modules/live/router.py');

test('los estilos y el tope son los mismos que en el servidor', () => {
  const estilos = /ESTILOS = \(([^)]*)\)/.exec(servidor);
  assert.ok(estilos);
  assert.deepEqual(
    estilos[1].split(',').map((e) => e.trim().replace(/"/g, '')).filter(Boolean),
    [...ESTILOS_DE_ROTULO],
  );
  assert.match(servidor, new RegExp(`MAXIMO_DE_ROTULO = ${MAXIMO_DE_ROTULO}\\b`));
  assert.match(servidor, new RegExp(`ESTILO_POR_OMISION = "${ESTILO_POR_OMISION}"`));
});

test('cada codigo que el servidor puede devolver tiene texto en los tres idiomas', () => {
  const codigos = new Set<string>();
  for (const fuente of [servidor, rutas]) {
    for (const casa of fuente.matchAll(/code="(live_(?:spotlight|message)_[a-z_]+)"/g)) {
      codigos.add(casa[1]);
    }
  }
  assert.deepEqual([...codigos].sort(), [
    'live_message_hidden',
    'live_spotlight_closed',
    'live_spotlight_layout_not_available',
    'live_spotlight_no_banner',
    'live_spotlight_not_available',
    'live_spotlight_rate_limited',
  ]);
  for (const codigo of codigos) {
    const clave = claveDelFalloDeDestacado(codigo);
    assert.ok(clave, `sin texto para ${codigo}`);
    for (const idioma of ['es', 'en', 'pt']) {
      assert.match(leer(`../i18n/${idioma}.ts`), new RegExp(`'${clave}': `), `${clave} en ${idioma}`);
    }
  }
});

/* ---------------------------------------------------------- el cableado --- */

test('el repositorio habla con las seis rutas del servidor', () => {
  const repositorio = sinComentarios(leer('../repositories/LiveRepository.ts'));
  for (const ruta of ['/spotlight`', '/spotlight/pin`', '/spotlight/banner`', '/spotlight/banner/layout`']) {
    assert.ok(repositorio.includes(ruta), ruta);
  }
  assert.match(repositorio, /spotlight\/pin`,\s*\{\s*method: 'PUT',\s*body: JSON\.stringify\(\{ message_id: mensajeId \}\)/);
  assert.match(
    repositorio,
    /spotlight\/banner`,\s*\{\s*method: 'PUT',\s*body: JSON\.stringify\(cuerpoDelRotulo\(texto, estilo, presentacion, conPosicion\)\)/,
  );
  assert.match(
    repositorio,
    /spotlight\/banner\/layout`,\s*\{\s*method: 'PATCH',\s*body: JSON\.stringify\(cuerpoDeLaDisposicion\(disposicion\)\)/,
  );
  assert.equal((repositorio.match(/spotlight\/(?:pin|banner)`,\s*\{\s*method: 'DELETE'/g) ?? []).length, 2);
  for (const ruta of ['/spotlight"', '/spotlight/pin"', '/spotlight/banner"', '/spotlight/banner/layout"']) {
    assert.ok(rutas.includes(`"/sessions/{session_id}${ruta}`), ruta);
  }
  assert.match(rutas, /@router\.patch\(\s*"\/sessions\/\{session_id\}\/spotlight\/banner\/layout"/);
});

test('el aviso de difusion usa el topico y la carga de las reglas', () => {
  const servicio = sinComentarios(leer('../services/directoEnVivo.ts'));
  const desde = servicio.indexOf('export function avisosDeDestacado');
  assert.ok(desde >= 0);
  const funcion = servicio.slice(desde, servicio.indexOf('\n}\n', desde));
  assert.match(funcion, /transporte\.abrir\(topicoDeDestacado\(emisionId\)/);
  assert.match(funcion, /conexion\.enviar\(avisoDeDestacado\(\)\)/);
});

test('la pantalla pregunta con medida y no decide nada por su cuenta', () => {
  const gancho = sinComentarios(leer('../hooks/useDestacadoDeDirecto.ts'));
  assert.match(gancho, /crearRepaso\(/);
  // Lo que se pinta sale siempre de una respuesta del servidor.
  assert.doesNotMatch(gancho, /setDestacado\(\(?\s*(?:actual|previo)/);
  // Un fallo de red no esconde las opciones: solo «no esta montado».
  assert.match(gancho, /if \(sinDestacado\(/);
});

test('el contador del campo cuenta lo mismo que rechaza el servidor', () => {
  const hoja = sinComentarios(leer('../components/live/HojaDeRotulo.tsx'));
  assert.match(hoja, /juzgarRotulo\(/);
  assert.match(hoja, /largoDelRotulo\(limpiarRotulo\(/);
  assert.match(hoja, /MAXIMO_DE_ROTULO/);
  // Nada de `.length` del texto crudo para decidir si cabe.
  assert.doesNotMatch(hoja, /texto\.length\s*[<>]=?\s*(?:80|MAXIMO)/);
});

test('el menu de un mensaje sale de las reglas, no de la pantalla', () => {
  const chat = sinComentarios(leer('../components/live/ChatDeDirecto.tsx'));
  assert.match(chat, /accionesDeMensaje\(\{/);
});
