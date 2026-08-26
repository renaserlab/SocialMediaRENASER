import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  alturasDeCamara,
  ALTO_PISTA,
  ALTO_SELECTOR,
  ANILLO,
} from './controlesDeCamara.ts';

/*
  Por que estas pruebas y no otras: el disparador estaba DEBAJO de la barra
  flotante de secciones y no habia forma de darse cuenta leyendo el archivo —los
  numeros (58, 24, 148) parecian razonables— ni probando en un emulador sin
  gesto de inicio, donde la zona segura es 0 y casi no se solapa. Solo se ve con
  la medida real de un telefono con gesto.

  Lo que se fija aqui es la regla, no los numeros: nada por debajo de la barra,
  y las capas sin pisarse.
*/

/** Lo que ocupa la barra en un telefono con gesto de inicio (inset 34). */
const CON_GESTO = 104;
/** Lo que ocupa en uno con boton fisico o en la web (inset 0). */
const SIN_GESTO = 78;

test('ningun control queda por debajo de la barra flotante', () => {
  for (const barra of [SIN_GESTO, CON_GESTO]) {
    const { pista, controles, selector, zoom } = alturasDeCamara(barra);
    // Este era el fallo: el disparador estaba a 58 con una barra que ocupa 104.
    assert.ok(pista >= barra, `la pista (${pista}) se mete bajo la barra (${barra})`);
    assert.ok(controles >= barra, `el disparador (${controles}) se mete bajo la barra`);
    assert.ok(selector >= barra, `el selector (${selector}) se mete bajo la barra`);
    assert.ok(zoom >= barra, `el zoom (${zoom}) se mete bajo la barra`);
  }
});

test('el disparador ENTERO queda por encima de la barra, no solo su base', () => {
  /*
    Lo que se tocaba no era el borde inferior del boton sino el circulo de 76 px.
    Con `bottom: 58` la base salvaba por poco algunos aparatos, pero el cuerpo
    del boton seguia tapado. Se comprueba el alto completo.
  */
  const barra = CON_GESTO;
  const { controles } = alturasDeCamara(barra);
  assert.ok(
    controles >= barra,
    'el disparador arranca por debajo de la barra',
  );
  assert.ok(controles + ANILLO > barra + ANILLO - 1, 'el disparador queda tapado a medias');
});

test('las capas se apilan sin pisarse', () => {
  const { pista, controles, selector, zoom } = alturasDeCamara(CON_GESTO);
  // Cada una empieza por encima de donde termina la de abajo.
  assert.ok(controles >= pista + ALTO_PISTA, 'el disparador pisa la pista de ayuda');
  assert.ok(selector >= controles + ANILLO, 'el selector de modo pisa el disparador');
  // Este si pasaba: zoom y selector compartian los mismos 148 px, asi que el
  // «2.4x» se pintaba justo encima de las etiquetas de modo.
  assert.ok(zoom >= selector + ALTO_SELECTOR, 'el nivel de zoom pisa el selector de modo');
});

test('el orden es siempre de abajo arriba', () => {
  const { pista, controles, selector, zoom } = alturasDeCamara(SIN_GESTO);
  assert.ok(pista < controles && controles < selector && selector < zoom);
});

test('una medida absurda no empuja nada fuera de la pantalla', () => {
  // Un inset negativo no deberia llegar nunca, pero si llega la camara tiene que
  // seguir siendo usable en vez de colocar los botones fuera del borde.
  const { pista } = alturasDeCamara(-50);
  assert.ok(pista > 0);
});
