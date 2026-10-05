import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DURACION,
  ESCALA_AL_ENCENDER,
  ESCALA_AL_PULSAR,
  duracionDeSalida,
  duracionEfectiva,
  escalaPulsada,
  opacidadPulsada,
  retrasoEnCascada,
} from './movimiento.ts';

/**
 * EL MOVIMIENTO DE LA APLICACIÓN, EN NÚMEROS.
 *
 * Lo que se fija aquí no es un gusto: es que un toque responda antes de que se
 * note la espera, que nada rebote como un juguete y que quien pidió reducir el
 * movimiento no pierda por ello ninguna información.
 */

test('los cuatro tiempos están en su franja', () => {
  assert.ok(DURACION.toque >= 80 && DURACION.toque <= 120);
  assert.ok(DURACION.breve >= 140 && DURACION.breve <= 180);
  assert.ok(DURACION.normal >= 200 && DURACION.normal <= 260);
  assert.ok(DURACION.panel >= 260 && DURACION.panel <= 340);
});

test('pulsar encoge poco, y lo grande menos que lo pequeño', () => {
  assert.ok(ESCALA_AL_PULSAR.superficie >= 0.94 && ESCALA_AL_PULSAR.superficie <= 0.99);
  assert.ok(ESCALA_AL_PULSAR.chip >= 0.94 && ESCALA_AL_PULSAR.chip <= 0.97);
  assert.ok(ESCALA_AL_PULSAR.superficie > ESCALA_AL_PULSAR.chip);
  assert.ok(ESCALA_AL_PULSAR.chip > ESCALA_AL_PULSAR.icono);
  // Encenderse sube, pero no se dobla.
  assert.ok(ESCALA_AL_ENCENDER > 1 && ESCALA_AL_ENCENDER <= 1.3);
});

test('la salida es más corta que la entrada', () => {
  for (const entrada of Object.values(DURACION)) {
    assert.ok(duracionDeSalida(entrada) < entrada);
  }
});

test('suelto no encoge; pulsado llega a su escala', () => {
  assert.equal(escalaPulsada(0, 0.97, false), 1);
  assert.ok(Math.abs(escalaPulsada(1, 0.97, false) - 0.97) < 1e-9);
  assert.ok(Math.abs(escalaPulsada(0.5, 0.9, false) - 0.95) < 1e-9);
});

test('con «reducir movimiento» no encoge, pero el toque se sigue viendo', () => {
  assert.equal(escalaPulsada(1, 0.9, true), 1, 'sin escala');
  assert.ok(opacidadPulsada(1, 0.85) < 1, 'la opacidad sí cambia');
  assert.equal(duracionEfectiva(DURACION.normal, true), 0, 'el cambio ocurre, pero de golpe');
  assert.equal(duracionEfectiva(DURACION.normal, false), DURACION.normal);
});

test('la cascada tiene tope: una lista larga no tarda segundos en aparecer', () => {
  assert.equal(retrasoEnCascada(0), 0);
  assert.equal(retrasoEnCascada(2), 80);
  assert.equal(retrasoEnCascada(40), retrasoEnCascada(6));
  assert.ok(retrasoEnCascada(40) <= 300);
});

// ---------------------------------------------------------------------------
// Los componentes compartidos usan ESTE movimiento y no uno propio
// ---------------------------------------------------------------------------

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

test('`Pulsable` anima en el hilo de la interfaz y respeta la reducción', () => {
  const pulsable = fuente('components/Pulsable.tsx');
  assert.match(pulsable, /from 'react-native-reanimated'/);
  assert.match(pulsable, /useReducedMotion\(\)/);
  assert.match(pulsable, /escalaPulsada\(presion\.value, escala, reducir\)/);
  // La háptica es opcional y nace apagada: vibrar en cada botón es ruido.
  assert.match(pulsable, /haptica = false/);
});

test('botón, chip, fila, segmentos y pestañas responden con el mismo componente', () => {
  for (const componente of ['Button', 'Chip', 'ListRow', 'SegmentedControl', 'Tabs']) {
    const codigo = fuente(`components/${componente}.tsx`);
    assert.match(codigo, /<Pulsable\b/, `${componente} no usa Pulsable`);
    assert.ok(
      !/style=\{\(\{ pressed \}/.test(codigo),
      `${componente} sigue pintando su propio estado pulsado`,
    );
  }
});

test('no entró una segunda biblioteca de animación', () => {
  const paquete = readFileSync(join(SRC, '..', 'package.json'), 'utf8');
  assert.ok(!/"moti"|"lottie-react-native"|"rive-react-native"|"@shopify\/react-native-skia"/.test(paquete));
  assert.match(paquete, /"react-native-reanimated"/);
});
