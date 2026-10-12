/**
 * De codigo de motivo a frase que se entiende.
 *
 * Lo que estas pruebas protegen es que la explicacion siga siendo VERDAD.
 * `TOPIC_MATCH` con «Carpintería» dentro tiene que salir como «coincide con lo
 * que quieres aprender: Carpintería», y `SIMILAR_INTERESTS` NO puede nombrar
 * ningun tema: eso revelaria lo que la otra persona busca, que es privado.
 *
 * Se ejecutan con `npm run test` (el runner de Node, sin dependencias).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  frasePorMotivo,
  frasePrincipal,
  frasesDeMotivos,
} from './motivoDeRecomendacion.ts';

describe('la frase de un motivo', () => {
  it('nombra los temas que coinciden', () => {
    assert.equal(
      frasePorMotivo({ code: 'TOPIC_MATCH', topics: ['Carpintería'] }),
      'Coincide con lo que quieres aprender: Carpintería',
    );
  });

  it('enumera varios temas en castellano, no separados por comas hasta el final', () => {
    assert.equal(
      frasePorMotivo({ code: 'TEACHES', topics: ['Carpintería', 'Construcción'] }),
      'Enseña Carpintería y Construcción',
    );
    assert.equal(
      frasePorMotivo({ code: 'TEACHES', topics: ['A', 'B', 'C'] }),
      'Enseña A, B y C',
    );
  });

  it('dice que alguien puede ayudar, no que sea experto', () => {
    // Declarar experiencia no es tenerla verificada. La frase no promete lo que
    // el sistema todavia no comprueba.
    assert.equal(
      frasePorMotivo({ code: 'EXPERIENCED', topics: ['Carpintería'] }),
      'Tiene experiencia práctica en Carpintería',
    );
  });

  it('NUNCA nombra un tema al hablar de intereses parecidos', () => {
    // Es la regla de privacidad hecha prueba: nombrar el tema diria que busca
    // la otra persona, y eso no es informacion publica.
    const frase = frasePorMotivo({ code: 'SIMILAR_INTERESTS', topics: [] });
    assert.equal(frase, 'Tienen intereses parecidos');
    assert.ok(!frase.includes(':'));
  });

  it('no pinta en crudo un codigo que esta version no conoce', () => {
    // El backend puede anadir motivos nuevos antes de que la aplicacion se
    // actualice. Ensenar «FOO_BAR» en pantalla seria peor que callarse.
    assert.equal(frasePorMotivo({ code: 'ALGO_NUEVO', topics: [] }), '');
  });

  it('sobrevive a un motivo de tema sin temas', () => {
    assert.equal(frasePorMotivo({ code: 'TOPIC_MATCH', topics: [] }), '');
  });
});

describe('la frase de la tarjeta', () => {
  it('usa el primer motivo, que es el mas informativo', () => {
    assert.equal(
      frasePrincipal([
        { code: 'TOPIC_MATCH', topics: ['Carpintería'] },
        { code: 'ACTIVE_CREATOR', topics: [] },
      ]),
      'Coincide con lo que quieres aprender: Carpintería',
    );
  });

  it('se salta los motivos que no saben explicarse', () => {
    assert.equal(
      frasePrincipal([
        { code: 'DESCONOCIDO', topics: [] },
        { code: 'PREFERRED_1_TO_1', topics: [] },
      ]),
      'Ofrece sesiones 1 a 1',
    );
  });

  it('sin ningun motivo util no inventa nada', () => {
    assert.equal(frasePrincipal([]), '');
    assert.equal(frasePrincipal([{ code: 'X', topics: [] }]), '');
  });
});

describe('el detalle de por que aparece', () => {
  it('devuelve todas las frases, sin huecos', () => {
    const frases = frasesDeMotivos([
      { code: 'TOPIC_MATCH', topics: ['Carpintería'] },
      { code: 'DESCONOCIDO', topics: [] },
      { code: 'CAN_HELP', topics: ['Carpintería'] },
    ]);
    assert.deepEqual(frases, [
      'Coincide con lo que quieres aprender: Carpintería',
      'Puede ayudarte con Carpintería',
    ]);
  });

  it('una voz nueva se dice tal cual, sin disfrazarla de coincidencia', () => {
    assert.deepEqual(frasesDeMotivos([{ code: 'NEW_VOICE', topics: [] }]), [
      'Una voz nueva que quizá no conoces',
    ]);
  });
});
