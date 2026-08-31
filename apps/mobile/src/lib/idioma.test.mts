/**
 * La eleccion de idioma se guarda, y «sin elegir» no es «español».
 *
 * Esta es la prueba del fallo que se arreglo: la pantalla de idioma reaparecia
 * en cada arranque porque no habia forma de distinguir a quien no habia
 * contestado todavia de quien habia contestado «español» —el valor por defecto
 * y la respuesta se escribian en el mismo sitio—.
 *
 * Se ejecutan con `npm run test` (el runner de Node, sin dependencias).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  IDIOMA_POR_DEFECTO,
  esIdiomaConocido,
  hayQueElegirIdioma,
  idiomaEfectivo,
  migraIdiomaGuardado,
} from './idioma.ts';

describe('sin elegir no es lo mismo que el idioma por defecto', () => {
  it('sin eleccion se pregunta, aunque se pinte en español', () => {
    assert.equal(hayQueElegirIdioma(null), true);
    assert.equal(idiomaEfectivo(null), IDIOMA_POR_DEFECTO);
  });

  it('elegir español ES una eleccion: no se vuelve a preguntar', () => {
    assert.equal(hayQueElegirIdioma('es'), false);
    assert.equal(idiomaEfectivo('es'), 'es');
  });

  it('elegir otro idioma tambien se respeta', () => {
    assert.equal(hayQueElegirIdioma('en'), false);
    assert.equal(idiomaEfectivo('en'), 'en');
  });
});

describe('lo guardado por las versiones anteriores', () => {
  it('quien ya habia elegido conserva su idioma y no vuelve a ver la pantalla', () => {
    const elegido = migraIdiomaGuardado({ language: 'en', languageSelected: true });
    assert.equal(elegido, 'en');
    assert.equal(hayQueElegirIdioma(elegido), false);
  });

  it('quien eligio español tampoco vuelve a verla', () => {
    const elegido = migraIdiomaGuardado({ language: 'es', languageSelected: true });
    assert.equal(elegido, 'es');
    assert.equal(hayQueElegirIdioma(elegido), false);
  });

  it('quien nunca contesto la ve una vez, aunque tuviera guardado el idioma por defecto', () => {
    assert.equal(migraIdiomaGuardado({ language: 'es', languageSelected: false }), null);
  });

  it('una instalacion sin nada guardado se trata como sin elegir', () => {
    assert.equal(migraIdiomaGuardado({}), null);
  });

  it('un idioma que ya no existe se trata como sin elegir', () => {
    assert.equal(migraIdiomaGuardado({ language: 'fr', languageSelected: true }), null);
    assert.equal(esIdiomaConocido('fr'), false);
    assert.equal(esIdiomaConocido('pt'), true);
  });
});
