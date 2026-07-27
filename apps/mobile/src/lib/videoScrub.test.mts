import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clampRatio,
  progressRatio,
  ratioAfterDrag,
  ratioAtTouch,
  secondsAt,
  stepSeconds,
} from './videoScrub.ts';

test('el arrastre no se sale de los extremos del video', () => {
  // Barra de 200 px: arrastrar 500 px a la derecha se queda en el final.
  assert.equal(ratioAfterDrag(0.5, 500, 200), 1);
  // Y hacia atras, en el principio.
  assert.equal(ratioAfterDrag(0.5, -500, 200), 0);
});

test('arrastrar media barra avanza medio video', () => {
  assert.equal(ratioAfterDrag(0, 100, 200), 0.5);
  assert.equal(ratioAfterDrag(0.25, 50, 200), 0.5);
});

test('sin ancho medido todavia, el arrastre no mueve nada', () => {
  // El primer render ocurre antes de saber cuanto mide la barra; dividir por
  // cero daria Infinity y la barra saltaria al final sola.
  assert.equal(ratioAfterDrag(0.3, 80, 0), 0.3);
  assert.equal(ratioAtTouch(80, 0), 0);
});

test('la duracion desconocida no se convierte en un salto al segundo cero', () => {
  // `duration` llega como 0 o NaN mientras el video carga.
  assert.equal(secondsAt(0.5, 0), 0);
  assert.equal(secondsAt(0.5, Number.NaN), 0);
  assert.equal(progressRatio(3, 0), 0);
  assert.equal(progressRatio(Number.NaN, 10), 0);
});

test('la posicion tocada se traduce al segundo correspondiente', () => {
  const ratio = ratioAtTouch(150, 300); // mitad de la barra
  assert.equal(ratio, 0.5);
  assert.equal(secondsAt(ratio, 60), 30);
});

test('el avance no pasa del 100 % aunque el reproductor se pase de largo', () => {
  // Al terminar, algunos reproductores informan un currentTime algo mayor que
  // la duracion; la barra no debe desbordarse.
  assert.equal(progressRatio(10.4, 10), 1);
  assert.equal(clampRatio(1.2), 1);
});

test('el salto de accesibilidad nunca es menor de un segundo', () => {
  assert.equal(stepSeconds(10), 1); // el 5 % de 10 s seria medio segundo
  assert.equal(stepSeconds(600), 30);
  assert.equal(stepSeconds(0), 0);
});
