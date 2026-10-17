/**
 * Que se pinta cuando la busqueda encuentra algo que NO son personas.
 *
 * EL FALLO QUE SE FIJA AQUI, con la captura delante: alguien publico un curso,
 * otra persona escribio palabras del tema, y la aplicacion contesto
 *
 *     «Sin resultados — No encontramos personas con ese nombre.»
 *
 * El curso estaba publicado, etiquetado y el backend lo devolvia. Lo que
 * fallaba es que el unico buscador al que se podia llegar solo preguntaba por
 * PERSONAS, y su estado vacio hablaba de nombres. Ahora los dos buscadores
 * preguntan a `GET /api/v1/search` y las filas se construyen aqui, una sola
 * vez, para que no vuelvan a separarse.
 *
 * Lo que estas pruebas impiden que vuelva:
 *
 *   · que una respuesta con cursos y sin personas se lea como «no hay nada»;
 *   · que un grupo vacio pinte su cabecera y de a entender que ahi falta algo;
 *   · que se pierda la linea que explica POR QUE «muebles» encontro
 *     carpinteria, sin la cual acertar parece un fallo;
 *   · que «Ver mas» aparezca cuando el backend no ha dicho que haya mas.
 *
 * Se ejecutan con `npm run test` (el runner de Node, sin dependencias).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  aplicar,
  debeDecirSinResultados,
  estadoInicial,
  filasDeResultados,
  lanzar,
} from './busquedaProgresiva.ts';
import type { RespuestaDeBusqueda, ResultadosDeBusqueda } from './busquedaProgresiva.ts';

const CURSO = {
  id: 'curso-1',
  title: 'Muebles de madera a medida',
  subtitle: 'Del tablero a la mesa',
  level: null,
  cover_path: null,
  price_minor: 0,
  currency: 'PEN',
  coming_soon: false,
  author_id: 'carlos',
  author_name: 'Carlos Vega',
  topics: ['Carpintería'],
};

const PERSONA = {
  id: 'ana',
  full_name: 'Ana Torres',
  username: 'ana',
  avatar_path: null,
  bio: '',
  offer_topics: [],
};

/** Unos resultados vacios a los que anadir solo lo que interesa a cada prueba. */
function resultados(parcial: Partial<ResultadosDeBusqueda> = {}): ResultadosDeBusqueda {
  return {
    temas: [],
    people: [],
    posts: [],
    hashtags: [],
    courses: [],
    events: [],
    siguiente: {},
    ...parcial,
  };
}

describe('un curso encontrado sin ninguna persona', () => {
  it('se pinta, en vez de dejar la pantalla vacia', () => {
    const filas = filasDeResultados(resultados({ courses: [CURSO] }));
    assert.deepEqual(
      filas.map((f) => f.kind),
      ['section', 'course'],
    );
    assert.equal(filas[0].kind === 'section' && filas[0].title, 'Escuela');
  });

  it('no pinta la cabecera de «Personas»: ese grupo no existe en esta respuesta', () => {
    const filas = filasDeResultados(resultados({ courses: [CURSO] }));
    const titulos = filas.flatMap((f) => (f.kind === 'section' ? [f.title] : []));
    assert.deepEqual(titulos, ['Escuela']);
  });

  it('la pantalla NO debe decir «sin resultados»', () => {
    // Es la comprobacion de la queja escrita entera: se busca, llega una
    // respuesta con cursos y sin personas, y el estado vacio no se pinta.
    const { estado, sello } = lanzar(estadoInicial(), 'quiero aprender a fabricar muebles');
    const respuesta: RespuestaDeBusqueda = { courses: [CURSO], next_offset: {} };
    const despues = aplicar(estado, sello, respuesta);

    assert.equal(debeDecirSinResultados(despues), false);
    assert.equal(filasDeResultados(despues.resultados).length, 2);
  });
});

describe('por que se encontro', () => {
  it('se dice en que temas se busco, antes que cualquier resultado', () => {
    const filas = filasDeResultados(
      resultados({
        temas: [{ id: 't1', slug: 'carpinteria', name: 'Carpintería' }],
        courses: [CURSO],
      }),
    );
    assert.equal(filas[0].kind, 'temas');
    assert.equal(
      filas[0].kind === 'temas' && filas[0].texto,
      'También buscamos en Carpintería',
    );
  });

  it('sin temas detectados no se anade ninguna linea', () => {
    const filas = filasDeResultados(resultados({ courses: [CURSO] }));
    assert.equal(filas.some((f) => f.kind === 'temas'), false);
  });
});

describe('el orden de los grupos', () => {
  it('personas, etiquetas, publicaciones, cursos y eventos', () => {
    const filas = filasDeResultados(
      resultados({
        people: [PERSONA],
        courses: [CURSO],
        hashtags: [{ tag: 'madera', display_tag: 'madera', posts_count: 3 }],
      }),
    );
    const titulos = filas.flatMap((f) => (f.kind === 'section' ? [f.title] : []));
    assert.deepEqual(titulos, ['Personas', 'Etiquetas', 'Escuela']);
  });

  it('cada fila lleva una clave distinta', () => {
    const filas = filasDeResultados(
      resultados({
        people: [PERSONA, { ...PERSONA, id: 'bruno' }],
        courses: [CURSO, { ...CURSO, id: 'curso-2' }],
      }),
    );
    const claves = filas.map((f) => f.key);
    assert.equal(new Set(claves).size, claves.length);
  });
});

describe('«Ver mas»', () => {
  it('no se ofrece si el backend no dijo que hubiera mas', () => {
    const filas = filasDeResultados(resultados({ courses: [CURSO] }), {
      verMas: () => {},
    });
    const seccion = filas.find((f) => f.kind === 'section');
    assert.equal(seccion?.kind === 'section' && seccion.action, undefined);
  });

  it('se ofrece cuando lo dijo, y solo en ese grupo', () => {
    const filas = filasDeResultados(
      resultados({ people: [PERSONA], courses: [CURSO], siguiente: { courses: 10 } }),
      { verMas: () => {} },
    );
    const acciones = filas.flatMap((f) =>
      f.kind === 'section' ? [[f.title, f.action] as const] : [],
    );
    assert.deepEqual(acciones, [
      ['Personas', undefined],
      ['Escuela', 'Ver más'],
    ]);
  });

  it('mientras un grupo se amplia, ningun grupo acepta pulsaciones', () => {
    // Dos paginas en vuelo a la vez se aplicarian en el orden en que vuelvan.
    const filas = filasDeResultados(
      resultados({ courses: [CURSO], siguiente: { courses: 10 } }),
      { verMas: () => {}, ampliando: 'courses' },
    );
    const seccion = filas.find((f) => f.kind === 'section');
    assert.equal(seccion?.kind === 'section' && seccion.action, 'Cargando…');
    assert.equal(seccion?.kind === 'section' && seccion.onAction, undefined);
  });

  it('sin `verMas` no se ofrece nunca: quien no sabe paginar no lo anuncia', () => {
    // Es el caso del buscador de Explorar, que pinta la primera pagina encima
    // del muro. Ofrecer un boton que no hace nada es peor que no ofrecerlo.
    const filas = filasDeResultados(
      resultados({ courses: [CURSO], siguiente: { courses: 10 } }),
    );
    const seccion = filas.find((f) => f.kind === 'section');
    assert.equal(seccion?.kind === 'section' && seccion.action, undefined);
  });
});

describe('nada encontrado', () => {
  it('no pinta ni una fila', () => {
    assert.deepEqual(filasDeResultados(resultados()), []);
  });
});
