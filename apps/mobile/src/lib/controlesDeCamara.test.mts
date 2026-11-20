import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  alturasDeCamara,
  ALTO_PISTA,
  ALTO_SELECTOR,
  ANILLO,
  nivelDeZoom,
  ZOOM_MAXIMO_IOS,
} from './controlesDeCamara.ts';

/*
  Por que estas pruebas y no otras: el disparador estuvo DEBAJO de la barra
  flotante y no habia forma de darse cuenta leyendo el archivo —los numeros
  (58, 24, 148) parecian razonables— ni probando en un emulador sin gesto de
  inicio, donde la zona segura es 0 y casi no se solapa. Solo se ve con la
  medida real de un telefono con gesto.

  Lo que se fija aqui es la regla, no los numeros: nada por debajo del margen,
  la barra de tipos de publicacion abajo del todo, y las capas sin pisarse.
*/

/** El margen en un telefono con gesto de inicio (inset 34): max(34, 8) + 8. */
const CON_GESTO = 42;
/** En uno con boton fisico o en la web (inset 0): max(0, 8) + 8. */
const SIN_GESTO = 16;

test('ningun control queda por debajo del margen inferior', () => {
  for (const margen of [SIN_GESTO, CON_GESTO]) {
    const { selector, pista, controles, zoom } = alturasDeCamara(margen);
    assert.ok(selector >= margen, `la barra de modos (${selector}) se mete bajo el margen (${margen})`);
    assert.ok(pista >= margen, `la pista (${pista}) se mete bajo el margen`);
    assert.ok(controles >= margen, `el disparador (${controles}) se mete bajo el margen`);
    assert.ok(zoom >= margen, `el zoom (${zoom}) se mete bajo el margen`);
  }
});

test('la barra de tipos de publicacion es lo de mas abajo, justo en el margen', () => {
  /*
    Ocupa el sitio de la barra de secciones, que flota exactamente a ese margen.
    Si empezara mas arriba habria un hueco donde antes habia una barra; si mas
    abajo, se meteria en la zona de gestos del telefono.
  */
  for (const margen of [SIN_GESTO, CON_GESTO]) {
    assert.equal(alturasDeCamara(margen).selector, margen);
  }
});

test('las capas se apilan sin pisarse', () => {
  const { selector, pista, controles, zoom } = alturasDeCamara(CON_GESTO);
  // Cada una empieza por encima de donde termina la de abajo.
  assert.ok(pista >= selector + ALTO_SELECTOR, 'la pista de ayuda pisa la barra de modos');
  assert.ok(controles >= pista + ALTO_PISTA, 'el disparador pisa la pista de ayuda');
  assert.ok(zoom >= controles + ANILLO, 'el nivel de zoom pisa el disparador');
});

test('el orden es siempre de abajo arriba', () => {
  const { selector, pista, controles, zoom } = alturasDeCamara(SIN_GESTO);
  assert.ok(selector < pista && pista < controles && controles < zoom);
});

test('en la franja de la pista caben dos lineas con su fondo', () => {
  /*
    La frase («Toca para una foto · Mantén para grabar · Desliza para acercar»)
    no cabe en una linea en casi ningun telefono. Con sitio para una sola, la
    segunda se pintaba encima del disparador o se salia de la pantalla.

    18,2 es el alto de linea del texto secundario; 6, el relleno vertical de la
    pildora que le da fondo, y 1, su borde (`StoryCaptureScreen`).
  */
  assert.ok(ALTO_PISTA >= 2 * 18.2 + 2 * 6 + 2 * 1, `en ${ALTO_PISTA} px no caben dos lineas`);
});

test('una medida absurda no empuja nada fuera de la pantalla', () => {
  // Un inset negativo no deberia llegar nunca, pero si llega la camara tiene que
  // seguir siendo usable en vez de colocar los botones fuera del borde.
  const { selector, pista } = alturasDeCamara(-50);
  assert.ok(selector >= 0);
  assert.ok(pista > 0);
});

/*
  El zoom del iPhone: el parche de expo-camera arranca en el lente normal y
  llega a 10x en curva. Si el numero de la pastilla no sigue la misma curva,
  enseña «3.2x» cuando la imagen esta en 2x.
*/
test('la pastilla del zoom en iOS va de 1x a 10x siguiendo la curva del parche', () => {
  assert.equal(nivelDeZoom(0, 'ios'), 1);
  assert.equal(nivelDeZoom(1, 'ios'), ZOOM_MAXIMO_IOS);
  assert.ok(Math.abs(nivelDeZoom(0.5, 'ios') - Math.sqrt(10)) < 1e-9);
  // Fuera de rango no inventa: ni por debajo de 1x ni por encima del tope.
  assert.equal(nivelDeZoom(-1, 'ios'), 1);
  assert.equal(nivelDeZoom(2, 'ios'), ZOOM_MAXIMO_IOS);
});

test('en Android la pastilla conserva la escala de siempre', () => {
  assert.equal(nivelDeZoom(0, 'android'), 1);
  assert.equal(nivelDeZoom(1, 'android'), 5);
});
