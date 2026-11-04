import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GIRO_MAXIMO, PASO_DE_TAMANO, TAMANO_MAXIMO, TAMANO_MINIMO, TAMANO_POR_OMISION } from './destacado.ts';
import {
  MARGEN_DEL_IMAN,
  REGLA_DE_GIRO,
  REGLA_DE_TAMANO,
  ajustarALaRegla,
  fraccionDe,
  pasoEnLaRegla,
  tramoRelleno,
  valorEn,
} from './reglaFina.ts';
import { ajustarTamano, pasoDeGiro } from './rotuloEnPantalla.ts';

/*
  Las barras de tamaño y giro de la hoja del texto (maqueta v2, aprobada el
  04/11/2026). Lo que importa: que nunca salga un valor que el servidor
  rechace, que el imán enganche lo de siempre y que el lector de pantalla
  pueda recorrerlas enteras.
*/

test('los rangos son los de destacado.ts, que son los del servidor', () => {
  assert.equal(REGLA_DE_TAMANO.minimo, TAMANO_MINIMO);
  assert.equal(REGLA_DE_TAMANO.maximo, TAMANO_MAXIMO);
  assert.equal(REGLA_DE_TAMANO.paso, PASO_DE_TAMANO);
  assert.equal(REGLA_DE_TAMANO.iman, TAMANO_POR_OMISION);
  assert.equal(REGLA_DE_GIRO.minimo, -GIRO_MAXIMO);
  assert.equal(REGLA_DE_GIRO.maximo, GIRO_MAXIMO);
  assert.equal(REGLA_DE_GIRO.iman, 0);
});

test('los extremos de la barra son los del servidor', () => {
  assert.equal(valorEn(0, REGLA_DE_TAMANO), TAMANO_MINIMO);
  assert.equal(valorEn(1, REGLA_DE_TAMANO), TAMANO_MAXIMO);
  assert.equal(valorEn(0, REGLA_DE_GIRO), -GIRO_MAXIMO);
  assert.equal(valorEn(1, REGLA_DE_GIRO), GIRO_MAXIMO);
  // El dedo fuera de la barra no la pasa.
  assert.equal(valorEn(-0.4, REGLA_DE_TAMANO), TAMANO_MINIMO);
  assert.equal(valorEn(1.7, REGLA_DE_GIRO), GIRO_MAXIMO);
});

test('cualquier sitio da un valor que el resto de la app también acepta', () => {
  for (let i = 0; i <= 1000; i++) {
    const f = i / 1000;
    const tamano = valorEn(f, REGLA_DE_TAMANO);
    assert.equal(tamano, ajustarTamano(tamano), `tamaño en ${f}`);
    const giro = valorEn(f, REGLA_DE_GIRO);
    assert.equal(giro, pasoDeGiro(giro, 0), `giro en ${f}`);
    assert.ok(Number.isInteger(giro));
  }
});

test('el imán engancha el 100 % y el 0°, y solo cerca', () => {
  const casi = (regla: typeof REGLA_DE_GIRO, delta: number) =>
    fraccionDe(regla.iman, regla) + delta;
  assert.equal(valorEn(casi(REGLA_DE_TAMANO, MARGEN_DEL_IMAN * 0.9), REGLA_DE_TAMANO), TAMANO_POR_OMISION);
  assert.equal(valorEn(casi(REGLA_DE_TAMANO, -MARGEN_DEL_IMAN * 0.9), REGLA_DE_TAMANO), TAMANO_POR_OMISION);
  assert.equal(valorEn(casi(REGLA_DE_GIRO, MARGEN_DEL_IMAN * 0.9), REGLA_DE_GIRO), 0);
  assert.notEqual(valorEn(casi(REGLA_DE_GIRO, MARGEN_DEL_IMAN * 2), REGLA_DE_GIRO), 0);
  assert.notEqual(valorEn(casi(REGLA_DE_TAMANO, MARGEN_DEL_IMAN * 2), REGLA_DE_TAMANO), TAMANO_POR_OMISION);
});

test('ida y vuelta: el pulgar se pinta donde está el valor', () => {
  for (const regla of [REGLA_DE_TAMANO, REGLA_DE_GIRO]) {
    for (let v = regla.minimo; v <= regla.maximo; v += regla.paso) {
      assert.equal(valorEn(fraccionDe(v, regla), regla), Math.abs(v - regla.iman) <= MARGEN_DEL_IMAN * (regla.maximo - regla.minimo) ? regla.iman : v);
    }
  }
});

test('el lector de pantalla sube y baja de paso en paso, sin salirse', () => {
  assert.equal(pasoEnLaRegla(100, 1, REGLA_DE_TAMANO), 105);
  assert.equal(pasoEnLaRegla(100, -1, REGLA_DE_TAMANO), 95);
  assert.equal(pasoEnLaRegla(TAMANO_MAXIMO, 1, REGLA_DE_TAMANO), TAMANO_MAXIMO);
  assert.equal(pasoEnLaRegla(TAMANO_MINIMO, -1, REGLA_DE_TAMANO), TAMANO_MINIMO);
  assert.equal(pasoEnLaRegla(0, 1, REGLA_DE_GIRO), 5);
  assert.equal(pasoEnLaRegla(-178, -1, REGLA_DE_GIRO), -GIRO_MAXIMO);
  // Recorrerla entera con gestos llega a los dos extremos.
  let v = TAMANO_MINIMO;
  for (let i = 0; i < 100; i++) v = pasoEnLaRegla(v, 1, REGLA_DE_TAMANO);
  assert.equal(v, TAMANO_MAXIMO);
});

test('lo que llega raro se queda en algo válido', () => {
  assert.equal(ajustarALaRegla(Number.NaN, REGLA_DE_GIRO), 0);
  assert.equal(ajustarALaRegla(Number.POSITIVE_INFINITY, REGLA_DE_TAMANO), TAMANO_POR_OMISION);
  assert.equal(valorEn(Number.NaN, REGLA_DE_TAMANO), TAMANO_POR_OMISION);
  assert.equal(fraccionDe(Number.NaN, REGLA_DE_TAMANO), 0);
  assert.equal(ajustarALaRegla(103, REGLA_DE_TAMANO), 105);
  // Sin «-0°» en pantalla.
  assert.ok(Object.is(ajustarALaRegla(-0.2, REGLA_DE_GIRO), 0));
});

test('el relleno del giro sale del 0° hacia cada lado; el del tamaño, del principio', () => {
  assert.deepEqual(tramoRelleno(0, REGLA_DE_GIRO), { desde: 0.5, hasta: 0.5 });
  assert.deepEqual(tramoRelleno(90, REGLA_DE_GIRO), { desde: 0.5, hasta: 0.75 });
  assert.deepEqual(tramoRelleno(-90, REGLA_DE_GIRO), { desde: 0.25, hasta: 0.5 });
  assert.deepEqual(tramoRelleno(TAMANO_MINIMO, REGLA_DE_TAMANO), { desde: 0, hasta: 0 });
  assert.deepEqual(tramoRelleno(TAMANO_MAXIMO, REGLA_DE_TAMANO), { desde: 0, hasta: 1 });
});
