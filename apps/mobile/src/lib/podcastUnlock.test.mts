/**
 * Pruebas de la liberación progresiva del podcast.
 *
 * Se ejecutan con `npm run test` (el runner que trae Node, sin dependencias).
 * La extensión `.mts` evita depender del tipo de módulo del paquete y la deja
 * fuera del `tsc --noEmit` de la app, que compila el código de las vistas.
 *
 * El módulo que se prueba recibe el reloj por parámetro, así que aquí se pueden
 * simular 8, 16 o 32 horas sin esperarlas ni tocar la hora del sistema.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DRIP_EPISODES,
  formatCountdown,
  gateFor,
  hasPendingUnlocks,
  waitingLabel,
} from './podcastUnlock.ts';

const HOUR = 3_600_000;
const START = Date.parse('2026-07-23T10:00:00Z');

/** Milisegundos que faltan para el episodio `index`, o error si ya está abierto. */
function remaining(index: number, now: number): number {
  const gate = gateFor(index, START, now);
  assert.equal(gate.state, 'waiting', `el episodio ${index + 1} debería estar esperando`);
  return gate.state === 'waiting' ? gate.remainingMs : 0;
}

describe('nada más empezar', () => {
  it('deja el primer episodio libre', () => {
    assert.equal(gateFor(0, START, START).state, 'open');
  });

  it('anuncia los siguientes en múltiplos de 8 horas', () => {
    assert.equal(waitingLabel(remaining(1, START)), 'Audio disponible dentro de 8 horas');
    assert.equal(waitingLabel(remaining(2, START)), 'Audio disponible dentro de 16 horas');
    assert.equal(waitingLabel(remaining(3, START)), 'Audio disponible dentro de 24 horas');
    assert.equal(waitingLabel(remaining(4, START)), 'Audio disponible dentro de 32 horas');
  });

  it('cuenta atrás en horas, minutos y segundos', () => {
    assert.equal(formatCountdown(remaining(1, START)), '08:00:00');
  });
});

describe('con el tiempo cumplido', () => {
  it('abre el segundo episodio a las 8 horas exactas', () => {
    const now = START + 8 * HOUR;
    assert.equal(gateFor(1, START, now).state, 'open');
    assert.equal(gateFor(2, START, now).state, 'waiting');
  });

  it('a las 32 horas están abiertos los cinco', () => {
    const now = START + 32 * HOUR;
    const states = [0, 1, 2, 3, 4].map((i) => gateFor(i, START, now).state);
    assert.deepEqual(states, ['open', 'open', 'open', 'open', 'open']);
    assert.equal(hasPendingUnlocks(START, now), false, 'ya no queda nada que contar');
  });

  it('no abre nunca los de membresía, por mucho que pase el tiempo', () => {
    const now = START + 500 * HOUR;
    assert.equal(gateFor(DRIP_EPISODES, START, now).state, 'membership');
  });
});

describe('detalles de presentación', () => {
  it('descuenta hasta el segundo', () => {
    // 20 h 30 min 15 s: al cuarto episodio (24 h) le faltan 3 h 29 min 45 s.
    const now = START + 20 * HOUR + 30 * 60_000 + 15_000;
    assert.equal(formatCountdown(remaining(3, now)), '03:29:45');
  });

  it('redondea el mensaje hacia arriba para no decir "0 horas"', () => {
    assert.equal(waitingLabel(59 * 60_000), 'Audio disponible dentro de 1 hora');
    const now = START + 20 * HOUR + 30 * 60_000 + 15_000;
    assert.equal(waitingLabel(remaining(3, now)), 'Audio disponible dentro de 4 horas');
  });
});

describe('la cuenta atrás avanza de verdad', () => {
  // Regresión: con el origen recalculado en cada repintado la resta daba
  // siempre lo mismo y el contador se veía clavado en 08:00:00. El origen se
  // fija una vez y solo se mueve el reloj.
  it('descuenta un segundo por cada segundo que pasa', () => {
    const marcas = [0, 1, 2, 59, 60].map((s) =>
      formatCountdown(remaining(1, START + s * 1000)),
    );
    assert.deepEqual(marcas, ['08:00:00', '07:59:59', '07:59:58', '07:59:01', '07:59:00']);
  });

  it('no repite valor entre dos instantes distintos', () => {
    const a = remaining(2, START + 1000);
    const b = remaining(2, START + 2000);
    assert.notEqual(a, b, 'el tiempo restante no puede quedarse quieto');
    assert.equal(a - b, 1000);
  });
});
