import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GRID_COLUMNS, GRID_GAP, gridItemSize } from './gridLayout.ts';

test('tres celdas y sus separaciones caben en el ancho medido', () => {
  const ancho = 360;
  const lado = gridItemSize(ancho);
  const ocupado = lado * GRID_COLUMNS + GRID_GAP * (GRID_COLUMNS - 1);
  assert.ok(ocupado <= ancho, `se pasa del ancho: ${ocupado} > ${ancho}`);
  // Y no sobra tanto como para que se note un hueco.
  assert.ok(ancho - ocupado < GRID_COLUMNS);
});

test('nunca se pasa del ancho, sea cual sea la pantalla', () => {
  // Se recorren anchos de telefono pequeno a tablet: si en alguno la suma se
  // pasa, la ultima celda cae a la fila siguiente y la cuadricula se descuadra.
  for (let ancho = 240; ancho <= 1400; ancho += 1) {
    const lado = gridItemSize(ancho);
    const ocupado = lado * GRID_COLUMNS + GRID_GAP * (GRID_COLUMNS - 1);
    assert.ok(ocupado <= ancho, `ancho ${ancho}: ocupa ${ocupado}`);
  }
});

test('sin ancho medido todavia no se dibuja nada', () => {
  // El primer render ocurre antes de medir; devolver un lado cualquiera
  // pintaria celdas del tamano equivocado durante un instante.
  assert.equal(gridItemSize(0), 0);
  assert.equal(gridItemSize(-10), 0);
  assert.equal(gridItemSize(Number.NaN), 0);
});

test('un contenedor mas estrecho que las separaciones no da un lado negativo', () => {
  assert.equal(gridItemSize(4), 0);
  assert.equal(gridItemSize(6), 0);
});

test('el lado es un entero: media unidad deja una linea suelta al pintar', () => {
  for (const ancho of [361, 375, 390, 412, 428]) {
    assert.equal(gridItemSize(ancho) % 1, 0);
  }
});

test('admite otras configuraciones de columnas', () => {
  assert.equal(gridItemSize(100, 2, 0), 50);
  assert.equal(gridItemSize(100, 1, 0), 100);
  assert.equal(gridItemSize(100, 0), 0);
});
