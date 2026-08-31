import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_HISTORIA_MS,
  MIN_HISTORIA_MS,
  duracionMedida,
  revisarDuracionDeHistoria,
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
