import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GRID_COLUMNS,
  GRID_GAP,
  GRID_TILE_ASPECT_RATIO,
  gridItemHeight,
  gridItemSize,
} from './gridLayout.ts';

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
  // Medido desde la separacion y no con cifras fijas: eran 4 y 6 cuando la
  // separacion era de 3 px, y con la de 1 px de ahora 6 ya da una celda.
  const separaciones = GRID_GAP * (GRID_COLUMNS - 1);
  assert.equal(gridItemSize(separaciones - 1), 0);
  assert.equal(gridItemSize(separaciones), 0);
  assert.equal(gridItemSize(4, 3, 3), 0);
  assert.equal(gridItemSize(6, 3, 3), 0);
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

// ---------------------------------------------------------------------------
// Celdas verticales 3:4, como la cuadricula del perfil de Instagram
// ---------------------------------------------------------------------------

test('la celda es vertical 3:4 y la separacion es la linea de 1 px de Instagram', () => {
  /*
    Instagram cambio en enero de 2025 los cuadrados del perfil por rectangulos
    altos, y su web los dibuja con `padding-bottom: 133.33%` (4 de alto por
    cada 3 de ancho) y 1 px entre celdas. Si alguien vuelve a poner cuadrados
    o 4:5 —la proporcion de las publicaciones del feed, que es otra cosa—, que
    lo haga a sabiendas.
  */
  assert.equal(GRID_TILE_ASPECT_RATIO, 3 / 4);
  assert.equal(GRID_GAP, 1);
  assert.equal(GRID_COLUMNS, 3);
});

test('el alto es 4/3 del ancho en los telefonos de siempre', () => {
  // [ancho de pantalla, ancho de celda, alto de celda]
  const casos: Array<[number, number, number]> = [
    [360, 119, 159],
    [375, 124, 165],
    [390, 129, 172],
    [412, 136, 181],
    [428, 142, 189],
  ];
  for (const [pantalla, ancho, alto] of casos) {
    assert.equal(gridItemSize(pantalla), ancho, `ancho de celda en ${pantalla}`);
    assert.equal(gridItemHeight(gridItemSize(pantalla)), alto, `alto de celda en ${pantalla}`);
  }
});

test('el alto es un entero y nunca se aleja de 4:3 mas de medio pixel', () => {
  for (let ancho = 240; ancho <= 1400; ancho += 1) {
    const lado = gridItemSize(ancho);
    const alto = gridItemHeight(lado);
    assert.equal(alto % 1, 0, `ancho ${ancho}: alto ${alto} no es entero`);
    assert.ok(alto > lado, `ancho ${ancho}: la celda no es vertical (${lado}x${alto})`);
    assert.ok(Math.abs(alto - (lado * 4) / 3) <= 0.5, `ancho ${ancho}: ${lado}x${alto} no es 3:4`);
  }
});

test('sin ancho todavia, tampoco hay alto', () => {
  assert.equal(gridItemHeight(0), 0);
  assert.equal(gridItemHeight(-5), 0);
  assert.equal(gridItemHeight(Number.NaN), 0);
  assert.equal(gridItemHeight(120, 0), 0);
});

test('admite otras proporciones', () => {
  assert.equal(gridItemHeight(100, 1), 100);
  assert.equal(gridItemHeight(100, 4 / 5), 125);
});
