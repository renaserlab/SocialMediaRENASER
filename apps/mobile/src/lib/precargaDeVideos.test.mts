import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  activoConPocoBuffer,
  BUFFER_ACTIVO,
  BUFFER_MINIMO,
  BUFFER_VECINO,
  crearCoordinadorDePrecarga,
  enVentanaDePrecarga,
  ESPERA_DE_INERCIA_MS,
  MAX_REPRODUCTORES,
  perfilDeBuffer,
  type EstadoDePrecarga,
} from './precargaDeVideos.ts';

/*
  Lo que se fija aqui es la regla de la precarga del muro de Inicio: el activo
  se lleva el ancho de banda, los vecinos solo lo justo para tener el primer
  fotograma, y nunca hay mas de cuatro reproductores vivos.
*/

const LIBRE: EstadoDePrecarga = { arrastrando: false, activoConPocoBuffer: false };

test('la ventana en telefonos es el anterior, el activo y los dos siguientes', () => {
  const vivos = [];
  for (let i = 0; i < 20; i++) if (enVentanaDePrecarga(i, 7)) vivos.push(i);
  assert.deepEqual(vivos, [6, 7, 8, 9]);
});

test('nunca hay mas de cuatro reproductores vivos, este donde este el activo', () => {
  assert.equal(MAX_REPRODUCTORES, 4);
  for (let activo = 0; activo < 30; activo++) {
    let vivos = 0;
    for (let i = 0; i < 30; i++) if (enVentanaDePrecarga(i, activo)) vivos++;
    assert.ok(vivos <= MAX_REPRODUCTORES, `con el activo en ${activo} habia ${vivos}`);
  }
});

test('la web conserva la ventana de antes (N-1..N+1)', () => {
  const vivos = [];
  for (let i = 0; i < 20; i++) if (enVentanaDePrecarga(i, 7, true)) vivos.push(i);
  assert.deepEqual(vivos, [6, 7, 8]);
});

test('el activo pide 15 s / 12 MB, como antes, pase lo que pase', () => {
  for (const arrastrando of [true, false]) {
    for (const activoConPoco of [true, false]) {
      assert.equal(perfilDeBuffer(0, { arrastrando, activoConPocoBuffer: activoConPoco }), BUFFER_ACTIVO);
    }
  }
  assert.equal(BUFFER_ACTIVO.preferredForwardBufferDuration, 15);
  assert.equal(BUFFER_ACTIVO.maxBufferBytes, 12 * 1024 * 1024);
});

test('los vecinos piden poco: unos 2 s y 1,5 MB', () => {
  for (const d of [-1, 1, 2]) assert.equal(perfilDeBuffer(d, LIBRE), BUFFER_VECINO);
  assert.ok(BUFFER_VECINO.preferredForwardBufferDuration <= 2);
  assert.ok(BUFFER_VECINO.maxBufferBytes <= 1.5 * 1024 * 1024);
});

test('con el activo justo de buffer, todos los vecinos se quedan en el minimo', () => {
  const estado = { arrastrando: false, activoConPocoBuffer: true };
  for (const d of [-1, 1, 2]) assert.equal(perfilDeBuffer(d, estado), BUFFER_MINIMO);
});

test('arrastrando, se frenan todos los vecinos menos el siguiente', () => {
  const estado = { arrastrando: true, activoConPocoBuffer: false };
  assert.equal(perfilDeBuffer(1, estado), BUFFER_VECINO);
  assert.equal(perfilDeBuffer(-1, estado), BUFFER_MINIMO);
  assert.equal(perfilDeBuffer(2, estado), BUFFER_MINIMO);
});

test('el minimo nunca es 0 (en iOS 0 significa «automatico») ni baja del suelo de ExoPlayer', () => {
  assert.ok(BUFFER_MINIMO.preferredForwardBufferDuration >= 0.5);
  assert.ok(BUFFER_MINIMO.maxBufferBytes >= 512 * 1024, 'cabe un fotograma clave de 1080p');
});

test('poco buffer: por debajo de 2 s se frena, y no se suelta hasta pasar de 5 s', () => {
  const lectura = (porDelante: number) => ({
    currentTime: 10,
    bufferedPosition: 10 + porDelante,
    duration: 60,
    cargando: false,
  });
  assert.equal(activoConPocoBuffer(lectura(1), false), true);
  assert.equal(activoConPocoBuffer(lectura(3), false), false);
  // Histeresis: con 3 s por delante sigue «justo» si ya lo estaba.
  assert.equal(activoConPocoBuffer(lectura(3), true), true);
  assert.equal(activoConPocoBuffer(lectura(6), true), false);
});

test('esperando datos siempre cuenta como poco buffer', () => {
  assert.equal(
    activoConPocoBuffer({ currentTime: 0, bufferedPosition: 30, duration: 60, cargando: true }, false),
    true,
  );
});

test('un video ya descargado hasta el final no frena a nadie', () => {
  assert.equal(
    activoConPocoBuffer({ currentTime: 3, bufferedPosition: 4, duration: 4, cargando: false }, true),
    false,
  );
});

test('si el reproductor no sabe cuanto lleva, los vecinos no se quedan frenados', () => {
  for (const bufferedPosition of [-1, Number.NaN]) {
    assert.equal(
      activoConPocoBuffer({ currentTime: 0, bufferedPosition, duration: 0, cargando: false }, true),
      false,
    );
  }
});

/** Temporizador falso: se dispara a mano. */
function reloj() {
  let siguiente = 1;
  const pendientes = new Map<number, { fn: () => void; ms: number }>();
  return {
    temporizador: {
      poner: (fn: () => void, ms: number) => {
        const id = siguiente++;
        pendientes.set(id, { fn, ms });
        return id;
      },
      quitar: (id: unknown) => {
        pendientes.delete(id as number);
      },
    },
    pendientes,
    disparar() {
      for (const [id, { fn }] of [...pendientes]) {
        pendientes.delete(id);
        fn();
      }
    },
  };
}

test('el coordinador avisa solo cuando algo cambia', () => {
  const r = reloj();
  const c = crearCoordinadorDePrecarga(r.temporizador);
  const vistos: EstadoDePrecarga[] = [];
  const quitar = c.suscribir((e) => vistos.push(e));
  c.inicioDeArrastre();
  c.inicioDeInercia(); // ya estaba arrastrando: no avisa
  c.finDeInercia();
  assert.deepEqual(
    vistos.map((e) => e.arrastrando),
    [true, false],
  );
  quitar();
  c.inicioDeArrastre();
  assert.equal(vistos.length, 2, 'tras desuscribirse no llegan avisos');
});

test('soltar el dedo sin inercia termina el gesto tras una espera corta', () => {
  const r = reloj();
  const c = crearCoordinadorDePrecarga(r.temporizador);
  c.inicioDeArrastre();
  c.finDeArrastre();
  assert.equal(c.estado().arrastrando, true, 'aun puede llegar la inercia');
  assert.equal([...r.pendientes.values()][0]?.ms, ESPERA_DE_INERCIA_MS);
  r.disparar();
  assert.equal(c.estado().arrastrando, false);
});

test('si llega la inercia, la espera se cancela y el gesto sigue hasta que acaba', () => {
  const r = reloj();
  const c = crearCoordinadorDePrecarga(r.temporizador);
  c.inicioDeArrastre();
  c.finDeArrastre();
  c.inicioDeInercia();
  assert.equal(r.pendientes.size, 0);
  assert.equal(c.estado().arrastrando, true);
  c.finDeInercia();
  assert.equal(c.estado().arrastrando, false);
});

test('un activo nuevo frena a los vecinos hasta que coge aire; al irse, los suelta', () => {
  const c = crearCoordinadorDePrecarga(reloj().temporizador);
  c.nuevoActivo();
  assert.equal(c.estado().activoConPocoBuffer, true);
  c.lecturaDelActivo({ currentTime: 0, bufferedPosition: 3, duration: 30, cargando: false });
  assert.equal(c.estado().activoConPocoBuffer, true, 'histeresis: 3 s aun es poco');
  c.lecturaDelActivo({ currentTime: 0, bufferedPosition: 6, duration: 30, cargando: false });
  assert.equal(c.estado().activoConPocoBuffer, false);
  c.nuevoActivo();
  c.sinActivo();
  assert.equal(c.estado().activoConPocoBuffer, false);
});

/*
  Cableado: se mira el CODIGO FUENTE, como el resto de pruebas de componentes.
  Lo que no se puede perder es que el muro use esta ventana, que la telemetria
  siga marcando el gesto y que la web no reciba perfiles de buffer.
*/
const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const leer = (ruta: string) => readFileSync(join(SRC, ruta), 'utf8');

test('el muro usa la ventana nueva y reparte el buffer con el coordinador', () => {
  const feed = leer('components/FeedVerticalDeVideos.tsx');
  assert.match(feed, /preload=\{activo && enVentanaDePrecarga\(index, indiceActivo, ES_WEB\)\}/);
  assert.match(feed, /coordinadorDePrecarga=\{ES_WEB \? undefined : coordinador\}/);
  assert.match(feed, /onMomentumScrollEnd=\{coordinador\.finDeInercia\}/);
  assert.match(feed, /drawDistance=\{ES_WEB \? altoDePagina : altoDePagina \* 2\}/);
});

test('el reproductor nace con su perfil y lo cambia en caliente', () => {
  const reproductor = leer('components/VideoPlayer.tsx');
  assert.match(reproductor, /p\.bufferOptions = \{ \.\.\.perfil \};/);
  assert.match(reproductor, /player\.bufferOptions = \{ \.\.\.perfil \};/);
  assert.match(reproductor, /coordinadorDePrecarga\.suscribir\(aplicar\)/);
  // La web no cambia de comportamiento: no conoce la precarga.
  const web = leer('components/VideoPlayer.web.tsx');
  assert.doesNotMatch(web, /distanciaAlActivo|coordinadorDePrecarga|bufferOptions/);
});
