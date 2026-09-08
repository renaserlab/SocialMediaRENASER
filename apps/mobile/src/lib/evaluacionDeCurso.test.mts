/**
 * Las reglas de la evaluación en el cliente, ejecutadas de verdad.
 *
 * La primera prueba de todas es la que dice que aquí NO se corrige: el teléfono
 * no recibe cuál es la respuesta correcta, así que nada de este módulo puede
 * calcular una nota.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { en } from '../i18n/en.ts';
import { es } from '../i18n/es.ts';
import { pt } from '../i18n/pt.ts';
import {
  avance,
  certificadosNoMontados,
  evaluacionNoMontada,
  faltan,
  loQueFalta,
  mensajeDeErrorDeCertificado,
  mensajeDeErrorDeEvaluacion,
  respondidas,
  sePuedeEnviar,
  sinEvaluacion,
} from './evaluacionDeCurso.ts';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const BLOQUE = new RegExp('/\\*[\\s\\S]*?\\*/', 'g');
const LINEA = new RegExp('//[^\\n]*', 'g');
const sinComentarios = (c: string) => c.replace(BLOQUE, ' ').replace(LINEA, ' ');

const t = ((clave: string) => clave) as never;
const CUATRO = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }];

describe('el teléfono no corrige', () => {
  it('la evaluación que llega no trae la respuesta correcta', () => {
    const REPO = sinComentarios(fuente('repositories/QuizRepository.ts'));
    assert.ok(!REPO.includes('is_correct'));
    assert.ok(!REPO.toLowerCase().includes('correcta:'));
  });

  it('y nada de la lógica calcula una nota', () => {
    const LOGICA = sinComentarios(fuente('lib/evaluacionDeCurso.ts'));
    for (const palabra of ['esCorrecta', 'aciertos', 'calificar', 'puntaje']) {
      assert.ok(!LOGICA.includes(palabra), `«${palabra}» no puede vivir aquí`);
    }
  });
});

describe('cuántas van respondidas', () => {
  it('cuenta las que tienen elección', () => {
    assert.equal(respondidas(CUATRO, {}), 0);
    assert.equal(respondidas(CUATRO, { p1: 'a', p3: 'b' }), 2);
    assert.equal(respondidas(CUATRO, { p1: 'a', p2: 'a', p3: 'a', p4: 'a' }), 4);
  });

  it('una respuesta a una pregunta que ya no está no cuenta', () => {
    // El autor puede reescribir la evaluación entre dos cargas.
    assert.equal(respondidas(CUATRO, { fantasma: 'a' }), 0);
    assert.equal(respondidas(CUATRO, { p1: 'a', fantasma: 'b' }), 1);
  });
});

describe('el avance del cuestionario', () => {
  it('dice los extremos tal cual', () => {
    // A diferencia del avance de un curso: aquí ni 0 ni 100 engañan.
    assert.equal(avance(4, 0), 0);
    assert.equal(avance(4, 4), 100);
  });

  it('redondea al entero', () => {
    assert.equal(avance(8, 3), 38);
    assert.equal(avance(3, 1), 33);
  });

  it('una evaluación sin preguntas no rompe la pantalla', () => {
    assert.equal(avance(0, 0), 0);
  });
});

describe('cuándo se puede enviar', () => {
  it('hacen falta todas', () => {
    // El servidor cuenta las no respondidas como falladas y cierra el intento
    // para siempre: dejar enviar a medias es regalar una nota más baja.
    assert.equal(sePuedeEnviar(CUATRO, { p1: 'a', p2: 'a', p3: 'a' }), false);
    assert.equal(sePuedeEnviar(CUATRO, { p1: 'a', p2: 'a', p3: 'a', p4: 'a' }), true);
  });

  it('un cuestionario vacío no se envía', () => {
    assert.equal(sePuedeEnviar([], {}), false);
  });

  it('y se dice cuántas faltan', () => {
    assert.equal(faltan(CUATRO, { p1: 'a' }), 3);
    assert.equal(faltan(CUATRO, { p1: 'a', p2: 'a', p3: 'a', p4: 'a' }), 0);
  });
});

describe('qué significa cada fallo', () => {
  it('la migración sin aplicar NO es un error', () => {
    assert.equal(evaluacionNoMontada({ code: 'course_quiz_not_available' }), true);
    assert.equal(evaluacionNoMontada({ code: 'course_quiz_not_found' }), false);
    assert.equal(evaluacionNoMontada(new Error('se cayó la red')), false);
  });

  it('«este curso no tiene evaluación» tampoco lo es', () => {
    assert.equal(sinEvaluacion({ code: 'course_quiz_not_found' }), true);
    assert.equal(sinEvaluacion({ code: 'course_quiz_access_required' }), false);
  });

  it('los certificados sin montar se distinguen igual', () => {
    assert.equal(
      certificadosNoMontados({ code: 'course_certificates_not_available' }),
      true,
    );
    assert.equal(certificadosNoMontados(new Error('vaya')), false);
  });

  it('los códigos del servidor están traducidos', () => {
    assert.equal(
      mensajeDeErrorDeEvaluacion({ code: 'quiz_attempt_already_submitted' }, t),
      'evaluacion.yaEnviado',
    );
    assert.equal(
      mensajeDeErrorDeCertificado({ code: 'certificate_course_not_completed' }, t),
      'certificado.sinTerminar',
    );
  });

  it('un fallo sin código se explica con lo que dijo el servidor', () => {
    assert.equal(
      mensajeDeErrorDeEvaluacion(new Error('El curso ya no existe.'), t),
      'El curso ya no existe.',
    );
    assert.equal(mensajeDeErrorDeCertificado(new Error('   '), t), 'common.tryAgain');
  });
});

describe('qué falta para terminar', () => {
  const base = {
    terminado: false,
    leccionesTotales: 4,
    leccionesHechas: 4,
    exigeEvaluacion: false,
    evaluacionAprobada: false,
  };

  it('nada, si ya está terminado', () => {
    assert.equal(loQueFalta({ ...base, terminado: true }), null);
  });

  it('el contenido va primero', () => {
    // Es lo que hay que hacer antes: mandar a alguien a la evaluación con
    // lecciones pendientes es mandarlo al sitio equivocado.
    assert.equal(
      loQueFalta({
        ...base,
        leccionesHechas: 2,
        exigeEvaluacion: true,
        evaluacionAprobada: false,
      }),
      'lecciones',
    );
  });

  it('y después la evaluación', () => {
    assert.equal(loQueFalta({ ...base, exigeEvaluacion: true }), 'evaluacion');
  });

  it('un curso sin lecciones no está terminado', () => {
    assert.equal(
      loQueFalta({ ...base, leccionesTotales: 0, leccionesHechas: 0 }),
      'lecciones',
    );
  });
});

describe('los tres idiomas dicen todo lo que la evaluación pregunta', () => {
  it('ninguna clave usada aquí falta en es, en o pt', () => {
    const usadas = [
      ...new Set(
        fuente('lib/evaluacionDeCurso.ts').match(
          new RegExp("t\\('([a-zA-Z.]+)' as never\\)", 'g'),
        ) ?? [],
      ),
    ].map((m) => m.slice(3, m.indexOf("'", 3)));

    assert.ok(usadas.length > 5, 'no se encontraron claves, la búsqueda falla');
    for (const [nombre, diccionario] of [
      ['es', es],
      ['en', en],
      ['pt', pt],
    ] as Array<[string, Record<string, string>]>) {
      for (const clave of usadas) {
        assert.ok(
          (diccionario[clave] ?? '').trim() !== '',
          `falta ${clave} en ${nombre}`,
        );
      }
    }
  });
});
