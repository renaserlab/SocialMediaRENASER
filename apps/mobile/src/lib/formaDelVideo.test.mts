import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAS_APAISADA, MAS_VERTICAL, esVertical, relacionDeVideo } from './formaDelVideo.ts';

/**
 * La caja de un video tiene que salir de sus medidas, no de una constante.
 *
 * El fallo que fija: el muro dibujaba SIEMPRE 16:9 y un video de movil en
 * vertical quedaba con franjas negras a los lados que ocupaban mas que el
 * propio video.
 */

test('un video vertical de movil se dibuja vertical', () => {
  // 1080x1920: lo que graba cualquier telefono en vertical.
  assert.equal(relacionDeVideo(1080, 1920), 9 / 16);
});

test('un video apaisado se dibuja apaisado', () => {
  assert.equal(relacionDeVideo(1920, 1080), 16 / 9);
});

test('un cuadrado se respeta', () => {
  assert.equal(relacionDeVideo(1000, 1000), 1);
});

test('sin medidas guardadas se conserva lo de siempre', () => {
  // Publicaciones anteriores a la migracion 0021: no cambian de tamaño solas.
  assert.equal(relacionDeVideo(undefined, undefined), MAS_APAISADA);
  assert.equal(relacionDeVideo(null, null), MAS_APAISADA);
  assert.equal(relacionDeVideo(0, 0), MAS_APAISADA);
  assert.equal(relacionDeVideo(1920, 0), MAS_APAISADA);
});

test('los extremos se recortan para que la tarjeta siga siendo una tarjeta', () => {
  // Una tira 1:4 ocuparia varias pantallas y empujaria fuera el autor y los
  // botones; un panoramico 4:1 quedaria como una rendija.
  assert.equal(relacionDeVideo(500, 2000), MAS_VERTICAL);
  assert.equal(relacionDeVideo(2000, 500), MAS_APAISADA);
});

test('un dato imposible no rompe la tarjeta', () => {
  assert.equal(relacionDeVideo(-10, 20), MAS_APAISADA);
  assert.equal(relacionDeVideo(Number.NaN, 1080), MAS_APAISADA);
});

test('saber si es vertical no depende de la caja', () => {
  assert.equal(esVertical(1080, 1920), true);
  assert.equal(esVertical(1920, 1080), false);
  assert.equal(esVertical(1000, 1000), false);
  assert.equal(esVertical(undefined, undefined), false);
});
