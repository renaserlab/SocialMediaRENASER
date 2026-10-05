import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUELO_DE_VOZ_DB, empujarNivel, nivelDeVoz } from '../lib/notaDeVoz.ts';

/**
 * QUE SE VEA —Y SE NOTE— QUE ESTÁ GRABANDO.
 *
 * Lo reportado: en la conversación hay un «bug en el ícono de grabando» y hace
 * falta «feedback con animaciones para que el usuario realmente sepa que está
 * grabando». La máquina de estados de la nota de voz ya existía y está
 * probada en `notaDeVozYChatSinHuecos` y `grabadoraNoTocaLoLiberado`; aquí se
 * fija lo que la hace VISIBLE: una onda que es la voz de verdad cuando se
 * puede medir, que no se finge cuando no, y una señal que no depende solo de
 * la vista.
 */

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = (codigo: string) =>
  codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const BOTON = sinComentarios(fuente('components/BotonDeNotaDeVoz.tsx'));
const ONDA = sinComentarios(fuente('components/OndaDeVoz.tsx'));
const GRABADORA = sinComentarios(fuente('hooks/useGrabadoraDeVoz.ts'));

describe('el nivel del micrófono', () => {
  it('sin medición no es silencio: es «no se sabe»', () => {
    assert.equal(nivelDeVoz(undefined), null);
    assert.equal(nivelDeVoz(null), null);
    assert.equal(nivelDeVoz(Number.NaN), null);
    assert.equal(nivelDeVoz(Number.NEGATIVE_INFINITY), null);
  });

  it('va de 0 a 1 y no se sale', () => {
    assert.equal(nivelDeVoz(0), 1, 'el máximo del micrófono');
    assert.equal(nivelDeVoz(SUELO_DE_VOZ_DB), 0, 'el suelo es silencio');
    assert.equal(nivelDeVoz(-160), 0, 'por debajo del suelo sigue siendo silencio');
    assert.equal(nivelDeVoz(6), 1, 'un pico por encima de 0 dB no pasa de 1');
    const medio = nivelDeVoz(SUELO_DE_VOZ_DB / 2);
    assert.ok(medio !== null && Math.abs(medio - 0.5) < 1e-9);
  });

  it('el ruido de fondo no mueve la onda', () => {
    // Una habitación tranquila ronda los -55 dB: tiene que quedar plano.
    assert.equal(nivelDeVoz(-55), 0);
  });

  it('el historial tiene tope y conserva lo más reciente', () => {
    let historia: number[] = [];
    for (let i = 1; i <= 30; i += 1) historia = empujarNivel(historia, i / 30, 26);
    assert.equal(historia.length, 26);
    assert.equal(historia.at(-1), 1, 'la última muestra entra por el final');
    assert.ok(Math.abs((historia[0] ?? 0) - 5 / 30) < 1e-9, 'y las más viejas se caen');
  });

  it('empujar no toca el historial que recibe', () => {
    const original = [0.1, 0.2];
    const siguiente = empujarNivel(original, 0.3, 26);
    assert.deepEqual(original, [0.1, 0.2]);
    assert.deepEqual(siguiente, [0.1, 0.2, 0.3]);
  });
});

describe('la grabadora mide de verdad', () => {
  it('el grabador se crea con la medición encendida', () => {
    assert.match(GRABADORA, /isMeteringEnabled: true/);
    assert.match(GRABADORA, /useAudioRecorder\(OPCIONES_DE_GRABACION\)/);
    // Las opciones viven fuera del hook: un objeto nuevo en cada render haría
    // que se creara otro grabador nativo.
    assert.ok(
      GRABADORA.indexOf('const OPCIONES_DE_GRABACION') < GRABADORA.indexOf('export function useGrabadoraDeVoz'),
    );
  });

  it('el nivel sale de la MISMA lectura que el reloj: una llamada nativa por tic', () => {
    const reloj = GRABADORA.slice(GRABADORA.indexOf('setInterval'));
    const tic = reloj.slice(0, reloj.indexOf('}, 200);'));
    assert.equal(tic.match(/getStatus\(\)/g)?.length, 1);
    assert.match(tic, /setNivel\(nivelDeVoz\(estado\.metering\)\);/);
  });

  it('no se mide a alta frecuencia en JavaScript', () => {
    // Cinco lecturas por segundo, las del reloj. Nada de un fotograma por tic.
    assert.match(GRABADORA, /\}, 200\);/);
    assert.ok(!/requestAnimationFrame/.test(GRABADORA + ONDA));
  });
});

describe('la onda', () => {
  it('sin medición NO dibuja barras: enseña una actividad que no finge ser la voz', () => {
    assert.match(ONDA, /if \(nivel === null\) return <ActividadDecorativa color=\{color\} \/>;/);
  });

  it('cada lectura entra en la onda aunque repita valor', () => {
    assert.match(ONDA, /\}, \[latido\]\);/);
    assert.match(ONDA, /empujarNivel\(previa, nivel, BARRAS\)/);
  });

  it('las barras se mueven en el hilo de la interfaz, con transformación', () => {
    assert.match(ONDA, /from 'react-native-reanimated'/);
    assert.match(ONDA, /transform: \[\{ scaleY: altura\.value \}\]/);
  });

  it('respeta «reducir movimiento» y no deja bucles huérfanos', () => {
    assert.match(ONDA, /useReducedMotion\(\)/);
    assert.match(ONDA, /if \(reducir\) return undefined;/, 'los puntos no laten en bucle');
    assert.match(ONDA, /return \(\) => cancelAnimation\(opacidad\);/);
  });

  it('es decorativa para el lector de pantalla', () => {
    assert.match(ONDA, /importantForAccessibility="no-hide-descendants"/);
  });
});

describe('el panel de grabación', () => {
  it('pinta la onda con el nivel real y el latido del reloj', () => {
    assert.match(BOTON, /<OndaDeVoz nivel=\{nivel\} latido=\{segundos\} color=\{colors\.text\} \/>/);
  });

  it('dice «Grabando» con texto, no solo con un punto', () => {
    const barra = BOTON.slice(BOTON.indexOf("{fase === 'grabando' ? ("), BOTON.indexOf('{enPrevia ? ('));
    assert.match(barra, /<PuntoQueLate color=\{colors\.danger\} \/>/);
    assert.match(barra, /t\('chat\.recording'\)/);
    assert.match(barra, /borderColor: colors\.danger/, 'la barra entera cambia');
  });

  it('empezar y parar se notan en la mano', () => {
    const efecto = BOTON.slice(BOTON.indexOf('const faseAnterior'), BOTON.indexOf('const enPrevia'));
    assert.match(efecto, /if \(fase === 'grabando'\) \{\s*haptics\.medium\(\);/);
    assert.match(efecto, /\} else if \(antes === 'grabando'\) \{\s*haptics\.light\(\);/);
  });

  it('y se anuncian a quien no ve la pantalla', () => {
    const efecto = BOTON.slice(BOTON.indexOf('const faseAnterior'), BOTON.indexOf('const enPrevia'));
    assert.match(efecto, /announceForAccessibility\(t\('chat\.recording'\)\)/);
    assert.match(efecto, /announceForAccessibility\(t\('chat\.recordingReady'\)\)/);
    assert.match(efecto, /announceForAccessibility\(t\('chat\.recordingFailed'\)\)/);
  });

  it('el botón de detener lleva un aro que late, y quieto con «reducir movimiento»', () => {
    assert.match(BOTON, /<AroQueLate color=\{colors\.danger\} \/>/);
    const aro = BOTON.slice(BOTON.indexOf('function AroQueLate'), BOTON.indexOf('function NotaSonando'));
    const guarda = aro.indexOf('if (sinMovimiento) {');
    const bucle = aro.indexOf('Animated.loop(');
    assert.ok(guarda !== -1 && bucle !== -1 && guarda < bucle);
    assert.match(aro, /return \(\) => bucle\.stop\(\);/);
    assert.match(aro, /useNativeDriver: true/);
  });

  it('las acciones siguen colgando solo de `onPress`', () => {
    // `Pulsable` anima por su cuenta; aquí no vuelve ningún gesto del que
    // dependa el envío.
    for (const prohibido of ['PanResponder', 'onPressIn', 'onPressOut', 'onLongPress']) {
      assert.ok(!BOTON.includes(prohibido), `BotonDeNotaDeVoz usa \`${prohibido}\`.`);
    }
    for (const accion of ['empezar', 'detener', 'cancelar', 'eliminar', 'enviar']) {
      assert.match(BOTON, new RegExp(`onPress=\\{${accion}\\}`), `falta ${accion}`);
    }
  });
});
