/**
 * De codigo de motivo de un CURSO a frase que se entiende.
 *
 * Lo que estas pruebas protegen es que la explicacion siga siendo VERDAD y
 * siga siendo LEGIBLE. Los temas de un curso llegan como IDENTIFICADORES, no
 * como nombres, asi que el fallo natural de este fichero es que un uuid acabe
 * dentro de una frase: «Porque quieres aprender 7c9e…». Aqui se fija que eso no
 * pueda pasar ni cuando el catalogo no llega, ni cuando llega a medias.
 *
 * Se ejecutan con `npm test` (el runner de Node, sin dependencias).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  frasePorMotivoDeCurso,
  frasePrincipalDeCurso,
  frasesDeMotivosDeCurso,
} from './motivoDeCurso.ts';

/** Un catalogo de mentira, con la forma del de verdad: id → nombre. */
const CATALOGO = {
  'a1b2c3d4-0000-0000-0000-000000000001': 'Inteligencia Artificial',
  'a1b2c3d4-0000-0000-0000-000000000002': 'Carpintería',
  'a1b2c3d4-0000-0000-0000-000000000003': 'Construcción',
};

const IA = 'a1b2c3d4-0000-0000-0000-000000000001';
const CARPINTERIA = 'a1b2c3d4-0000-0000-0000-000000000002';
const CONSTRUCCION = 'a1b2c3d4-0000-0000-0000-000000000003';
const DESCONOCIDO = 'ffffffff-0000-0000-0000-00000000ffff';

describe('la frase de un motivo', () => {
  it('nombra el tema que se quiere aprender', () => {
    assert.equal(
      frasePorMotivoDeCurso({ code: 'COURSE_TOPIC_MATCH', topics: [IA] }, CATALOGO),
      'Porque quieres aprender Inteligencia Artificial',
    );
  });

  it('enumera varios temas en castellano, no separados por comas hasta el final', () => {
    assert.equal(
      frasePorMotivoDeCurso(
        { code: 'COURSE_TOPIC_MATCH', topics: [CARPINTERIA, CONSTRUCCION] },
        CATALOGO,
      ),
      'Porque quieres aprender Carpintería y Construcción',
    );
    assert.equal(
      frasePorMotivoDeCurso(
        { code: 'COURSE_TOPIC_MATCH', topics: [IA, CARPINTERIA, CONSTRUCCION] },
        CATALOGO,
      ),
      'Porque quieres aprender Inteligencia Artificial, Carpintería y Construcción',
    );
  });

  it('NUNCA deja un identificador dentro de la frase', () => {
    // El caso que rompe esto de verdad: el catalogo no llegó (red caida, o la
    // migracion de temas de curso sin aplicar). La frase degrada a su version
    // sin tema; lo que no puede es ensenar el uuid.
    const sinCatalogo = frasePorMotivoDeCurso({ code: 'COURSE_TOPIC_MATCH', topics: [IA] }, {});
    assert.equal(sinCatalogo, 'Porque trata de algo que quieres aprender');
    assert.ok(!sinCatalogo.includes(IA));

    const noEstaEnElCatalogo = frasePorMotivoDeCurso(
      { code: 'COURSE_TOPIC_MATCH', topics: [DESCONOCIDO] },
      CATALOGO,
    );
    assert.ok(!noEstaEnElCatalogo.includes(DESCONOCIDO));
  });

  it('con el catalogo a medias, nombra los que sabe y calla los que no', () => {
    // Un tema anadido despues de cargarse el catalogo no puede llevarse por
    // delante los que si se saben traducir.
    assert.equal(
      frasePorMotivoDeCurso(
        { code: 'COURSE_TOPIC_MATCH', topics: [IA, DESCONOCIDO] },
        CATALOGO,
      ),
      'Porque quieres aprender Inteligencia Artificial',
    );
  });

  it('sobrevive a un motivo de tema sin temas', () => {
    assert.equal(
      frasePorMotivoDeCurso({ code: 'COURSE_TOPIC_MATCH', topics: [] }, CATALOGO),
      'Porque trata de algo que quieres aprender',
    );
  });

  it('dice en voz alta que un curso aparece por descubrir, sin disfrazarlo', () => {
    // Presentar una exploracion como si encajara con lo que alguien busca
    // ensena a desconfiar del resto de las frases.
    const frase = frasePorMotivoDeCurso({ code: 'WORTH_A_LOOK', topics: [] }, CATALOGO);
    assert.equal(frase, 'Todavía no lo ha visto mucha gente');
  });

  it('no promete un seguimiento que quiza no existe', () => {
    // `CREATOR_AFFINITY` se dispara tambien por consumo sin seguir a nadie.
    assert.equal(
      frasePorMotivoDeCurso({ code: 'CREATOR_AFFINITY', topics: [] }, CATALOGO),
      'De alguien cuyo contenido ya te interesa',
    );
  });

  it('los motivos sin tema no cambian aunque haya catalogo', () => {
    assert.equal(
      frasePorMotivoDeCurso({ code: 'LEARNING_GOAL_MATCH', topics: [] }, CATALOGO),
      'Encaja con lo que buscas: aprender',
    );
    assert.equal(
      frasePorMotivoDeCurso({ code: 'PREFERRED_COURSE_FORMAT', topics: [] }, CATALOGO),
      'Prefieres aprender en formato curso',
    );
    assert.equal(
      frasePorMotivoDeCurso({ code: 'RECENT_INTEREST', topics: [] }, CATALOGO),
      'Por lo que has estado viendo últimamente',
    );
    assert.equal(
      frasePorMotivoDeCurso({ code: 'NEW_COURSE', topics: [] }, CATALOGO),
      'Se publicó hace poco',
    );
  });

  it('no pinta en crudo un codigo que esta version no conoce', () => {
    // El backend puede anadir motivos nuevos antes de que la aplicacion se
    // actualice. Ensenar «FOO_BAR» en pantalla seria peor que callarse.
    assert.equal(frasePorMotivoDeCurso({ code: 'ALGO_NUEVO', topics: [] }, CATALOGO), '');
  });
});

describe('la frase de la tarjeta', () => {
  it('usa el primer motivo, que es el mas informativo', () => {
    assert.equal(
      frasePrincipalDeCurso(
        [
          { code: 'COURSE_TOPIC_MATCH', topics: [CARPINTERIA] },
          { code: 'NEW_COURSE', topics: [] },
        ],
        CATALOGO,
      ),
      'Porque quieres aprender Carpintería',
    );
  });

  it('se salta los motivos que no saben explicarse', () => {
    assert.equal(
      frasePrincipalDeCurso(
        [
          { code: 'DESCONOCIDO', topics: [] },
          { code: 'PREFERRED_COURSE_FORMAT', topics: [] },
        ],
        CATALOGO,
      ),
      'Prefieres aprender en formato curso',
    );
  });

  it('sin ningun motivo util no inventa nada', () => {
    assert.equal(frasePrincipalDeCurso([], CATALOGO), '');
    assert.equal(frasePrincipalDeCurso([{ code: 'X', topics: [] }], CATALOGO), '');
  });

  it('sin catalogo sigue diciendo algo, nunca un identificador', () => {
    // Es el arranque real de la seccion: los cursos pueden llegar antes que el
    // catalogo de temas, y la tarjeta se pinta igualmente.
    assert.equal(
      frasePrincipalDeCurso([{ code: 'COURSE_TOPIC_MATCH', topics: [IA] }]),
      'Porque trata de algo que quieres aprender',
    );
  });
});

describe('el detalle de por que aparece', () => {
  it('devuelve todas las frases, sin huecos', () => {
    const frases = frasesDeMotivosDeCurso(
      [
        { code: 'COURSE_TOPIC_MATCH', topics: [CARPINTERIA] },
        { code: 'DESCONOCIDO', topics: [] },
        { code: 'CREATOR_AFFINITY', topics: [] },
      ],
      CATALOGO,
    );
    assert.deepEqual(frases, [
      'Porque quieres aprender Carpintería',
      'De alguien cuyo contenido ya te interesa',
    ]);
  });

  it('un curso nuevo se dice tal cual, sin disfrazarlo de coincidencia', () => {
    assert.deepEqual(frasesDeMotivosDeCurso([{ code: 'NEW_COURSE', topics: [] }], CATALOGO), [
      'Se publicó hace poco',
    ]);
  });
});
