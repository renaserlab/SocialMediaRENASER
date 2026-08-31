import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_HISTORIA_MS,
  MIN_HISTORIA_MS,
  desplazarTramo,
  duracionMedida,
  largoDelTramo,
  moverFin,
  moverInicio,
  reloj,
  revisarDuracionDeHistoria,
  tramoInicial,
  tramoValido,
} from './historias.ts';

/**
 * El limite de treinta segundos, comprobado como decision y no como numero.
 *
 * El fallo que fija: la comprobacion era `(elegido.durationMs ?? 0) > TOPE`, o
 * sea que un video del que no se sabia la duracion valia CERO y pasaba. Con
 * eso, cualquier video de cualquier duracion entraba por el carrete siempre que
 * el selector no informara —que es lo normal en varios Android—.
 */

test('menos de treinta segundos se publica', () => {
  const decision = revisarDuracionDeHistoria(29_500);
  assert.equal(decision.estado, 'cabe');
  assert.equal(decision.estado === 'cabe' && decision.durationMs, 29_500);
});

test('exactamente treinta segundos entra', () => {
  assert.equal(revisarDuracionDeHistoria(MAX_HISTORIA_MS).estado, 'cabe');
});

test('mas de treinta segundos NO se publica, y se dice por que', () => {
  const decision = revisarDuracionDeHistoria(45_000);
  assert.equal(decision.estado, 'demasiado-larga');
  if (decision.estado !== 'demasiado-larga') return;
  // El mensaje tiene que llevar el dato concreto y una salida real, no un «no
  // se puede» a secas.
  assert.match(decision.mensaje, /45/);
  assert.match(decision.mensaje, /30/);
  assert.match(decision.mensaje, /recort/i);
});

test('no poder medir NO es durar cero', () => {
  for (const valor of [null, undefined, 0]) {
    const decision = revisarDuracionDeHistoria(valor);
    assert.equal(decision.estado, 'sin-medir', `valor: ${String(valor)}`);
  }
});

test('un video muy corto se sube al minimo que admite el visor', () => {
  const decision = revisarDuracionDeHistoria(200);
  assert.equal(decision.estado, 'cabe');
  assert.equal(decision.estado === 'cabe' && decision.durationMs, MIN_HISTORIA_MS);
});

test('entre dos medidas manda la mayor', () => {
  // Si una de las dos fuentes dice que el video es largo, es largo: un limite
  // que se relaja cuando una fuente falla no es un limite.
  assert.equal(duracionMedida(3_000, 42_000), 42_000);
  assert.equal(duracionMedida(42_000, 3_000), 42_000);
  assert.equal(duracionMedida(null, 12_000), 12_000);
  assert.equal(duracionMedida(12_000, null), 12_000);
  assert.equal(duracionMedida(null, null), null);
  assert.equal(duracionMedida(0, 0), null);
  assert.equal(duracionMedida(Number.NaN, 5_000), 5_000);
});

/* ------------------------------------------------------------------------- *
 * EL TRAMO
 *
 * Lo que se comprueba aqui es UNA cosa, repetida desde todos los angulos: sea
 * cual sea el gesto —mover el principio, mover el final, arrastrar el tramo
 * entero, pasarse por arriba o por abajo—, NUNCA sale un tramo de mas de
 * treinta segundos ni uno que se salga del video.
 *
 * El servidor lo revisa otra vez (`stories/recorte.py`), y por eso esto no es
 * el control de verdad. Pero un recortador que deje elegir lo que el servidor
 * va a rechazar es un recortador que hace perder una subida entera.
 * ------------------------------------------------------------------------- */

const CINCO_MINUTOS = 300_000;

test('al abrir, el tramo propuesto son los primeros treinta segundos', () => {
  const tramo = tramoInicial(CINCO_MINUTOS);
  assert.deepEqual(tramo, { inicioMs: 0, finMs: MAX_HISTORIA_MS });
});

test('un video que ya cabe se propone entero', () => {
  assert.deepEqual(tramoInicial(12_000), { inicioMs: 0, finMs: 12_000 });
});

test('cada tirador mueve solo su lado', () => {
  const desde = { inicioMs: 60_000, finMs: 85_000 };
  assert.deepEqual(moverInicio(CINCO_MINUTOS, desde, 70_000), {
    inicioMs: 70_000,
    finMs: 85_000,
  });
  assert.deepEqual(moverFin(CINCO_MINUTOS, desde, 80_000), {
    inicioMs: 60_000,
    finMs: 80_000,
  });
});

test('el tirador del principio no puede adelantar al del final', () => {
  const tramo = moverInicio(CINCO_MINUTOS, { inicioMs: 60_000, finMs: 85_000 }, 200_000);
  assert.equal(tramo.finMs, 85_000);
  assert.equal(largoDelTramo(tramo), MIN_HISTORIA_MS);
});

test('el tirador del final no puede estirar el tramo por encima del tope', () => {
  const tramo = moverFin(CINCO_MINUTOS, tramoInicial(CINCO_MINUTOS), 200_000);
  assert.equal(tramo.inicioMs, 0);
  assert.equal(largoDelTramo(tramo), MAX_HISTORIA_MS);
});

test('alejar el principio del final tampoco pasa del tope', () => {
  const tramo = moverInicio(CINCO_MINUTOS, { inicioMs: 100_000, finMs: 125_000 }, 0);
  assert.equal(tramo.finMs, 125_000);
  assert.equal(largoDelTramo(tramo), MAX_HISTORIA_MS);
});

test('acercar el final al principio acorta el tramo', () => {
  const tramo = moverFin(CINCO_MINUTOS, tramoInicial(CINCO_MINUTOS), 8_000);
  assert.deepEqual(tramo, { inicioMs: 0, finMs: 8_000 });
});

test('nunca sale un tramo por debajo del minimo del visor', () => {
  const tramo = moverFin(CINCO_MINUTOS, { inicioMs: 10_000, finMs: 40_000 }, 10_100);
  assert.ok(largoDelTramo(tramo) >= MIN_HISTORIA_MS, JSON.stringify(tramo));
});

test('arrastrar el tramo entero no cambia lo que dura', () => {
  const inicial = { inicioMs: 60_000, finMs: 80_000 };
  const movido = desplazarTramo(CINCO_MINUTOS, inicial, 25_000);
  assert.deepEqual(movido, { inicioMs: 85_000, finMs: 105_000 });
  assert.equal(largoDelTramo(movido), largoDelTramo(inicial));
});

test('al chocar con el final del video el tramo se queda pegado, no encoge', () => {
  const movido = desplazarTramo(CINCO_MINUTOS, { inicioMs: 280_000, finMs: 300_000 }, 90_000);
  assert.deepEqual(movido, { inicioMs: 280_000, finMs: 300_000 });
});

test('al chocar con el principio tampoco encoge', () => {
  const movido = desplazarTramo(CINCO_MINUTOS, { inicioMs: 10_000, finMs: 40_000 }, -90_000);
  assert.deepEqual(movido, { inicioMs: 0, finMs: 30_000 });
});

test('ningun gesto puede producir un tramo invalido', () => {
  // Se barren posiciones absurdas a proposito: negativas, mas alla del final,
  // y justo en los bordes. Si alguna cuenta se descuadra, aqui sale.
  const posiciones = [-500_000, -1, 0, 1, 29_999, 30_000, 150_000, 299_999, 300_000, 900_000];
  for (const p of posiciones) {
    const desdeInicio = moverInicio(CINCO_MINUTOS, tramoInicial(CINCO_MINUTOS), p);
    assert.ok(tramoValido(CINCO_MINUTOS, desdeInicio), `moverInicio(${p}): ${JSON.stringify(desdeInicio)}`);
    const desdeFin = moverFin(CINCO_MINUTOS, tramoInicial(CINCO_MINUTOS), p);
    assert.ok(tramoValido(CINCO_MINUTOS, desdeFin), `moverFin(${p}): ${JSON.stringify(desdeFin)}`);
    const desplazado = desplazarTramo(CINCO_MINUTOS, tramoInicial(CINCO_MINUTOS), p);
    assert.ok(tramoValido(CINCO_MINUTOS, desplazado), `desplazar(${p}): ${JSON.stringify(desplazado)}`);
  }
});

test('un tramo mas largo que el tope NO es valido', () => {
  assert.equal(tramoValido(CINCO_MINUTOS, { inicioMs: 0, finMs: 45_000 }), false);
});

test('un tramo que se sale del video NO es valido', () => {
  assert.equal(tramoValido(60_000, { inicioMs: 50_000, finMs: 70_000 }), false);
});

test('las marcas de tiempo se leen como en un reproductor', () => {
  assert.equal(reloj(0), '0:00');
  assert.equal(reloj(9_400), '0:09');
  assert.equal(reloj(65_000), '1:05');
  assert.equal(reloj(600_000), '10:00');
});
