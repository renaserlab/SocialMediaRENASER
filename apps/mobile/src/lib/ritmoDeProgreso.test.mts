/**
 * El ritmo al que se guarda el progreso.
 *
 * Las dos cosas que no pueden pasar: una peticion por aviso del reproductor
 * (catorce mil en una leccion de una hora) y guardar solo al salir (quien
 * cierra de golpe pierde todo lo visto).
 *
 * Se ejecutan con `npm run test` (el runner de Node, sin dependencias).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CADA_SEGUNDOS, debeGuardar, MINIMO_PARA_GUARDAR } from './ritmoDeProgreso.ts';

describe('cuando se guarda el progreso', () => {
  it('no guarda por un toque de dos segundos', () => {
    assert.equal(debeGuardar({ guardado: 0 }, MINIMO_PARA_GUARDAR - 1), false);
  });

  it('no guarda en cada aviso del reproductor', () => {
    // El reproductor avisa cuatro veces por segundo: 0.25, 0.5, 0.75…
    for (const segundos of [4, 5, 6, 10, 14]) {
      assert.equal(
        debeGuardar({ guardado: 0 }, segundos),
        false,
        `${segundos}s no deberia guardar todavia`,
      );
    }
  });

  it('guarda al acumular el intervalo de avance', () => {
    assert.equal(debeGuardar({ guardado: 0 }, CADA_SEGUNDOS), true);
    assert.equal(debeGuardar({ guardado: 100 }, 100 + CADA_SEGUNDOS), true);
  });

  it('cuenta segundos DE VIDEO, no de reloj', () => {
    // Un video pausado no avanza, asi que no genera ninguna peticion por mucho
    // rato que pase.
    assert.equal(debeGuardar({ guardado: 60 }, 60), false);
    assert.equal(debeGuardar({ guardado: 60 }, 60), false);
  });

  it('guarda en los momentos en los que puede no haber otra oportunidad', () => {
    // Pausa, cambio de leccion, salir, segundo plano, final.
    assert.equal(debeGuardar({ guardado: 0 }, 5, true), true);
    assert.equal(debeGuardar({ guardado: 100 }, 104, true), true);
  });

  it('ni forzado guarda un toque', () => {
    assert.equal(debeGuardar({ guardado: 0 }, 1, true), false);
  });

  it('rebobinar no borra lo avanzado', () => {
    assert.equal(debeGuardar({ guardado: 500 }, 120), false);
    assert.equal(debeGuardar({ guardado: 500 }, 120, true), false);
  });

  it('no reguarda exactamente lo mismo', () => {
    assert.equal(debeGuardar({ guardado: 300 }, 300, true), false);
  });
});
