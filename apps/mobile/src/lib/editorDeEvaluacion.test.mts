/**
 * Las reglas del editor de la evaluación, ejecutadas de verdad.
 *
 * La que más importa es la de marcar la correcta: una pregunta con dos
 * correctas la rechaza la base, así que la interfaz no puede dejar llegar ahí.
 * Y la contraria, que es menos evidente: al borrar la correcta NO se pasa la
 * marca a la vecina. Elegir por su cuenta la respuesta buena de un examen es
 * justo lo que una interfaz no puede hacer.
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
  MAXIMO_DE_ALTERNATIVAS,
  MINIMO_DE_ALTERNATIVAS,
  conAlternativaNueva,
  hayCambiosSinGuardar,
  marcarCorrecta,
  motivoParaNoPublicar,
  moverPregunta,
  notaMinimaValida,
  preguntaNueva,
  sinAlternativa,
  type PreguntaEditable,
} from './editorDeEvaluacion.ts';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const buena = (): PreguntaEditable => ({
  enunciado: '¿Cuál?',
  alternativas: [
    { texto: 'Sí', esCorrecta: true },
    { texto: 'No', esCorrecta: false },
  ],
});

describe('marcar la respuesta correcta', () => {
  it('apaga las demás: es opción única, no casillas', () => {
    const alternativas = [
      { texto: 'a', esCorrecta: true },
      { texto: 'b', esCorrecta: false },
      { texto: 'c', esCorrecta: false },
    ];
    const despues = marcarCorrecta(alternativas, 2);
    assert.deepEqual(
      despues.map((a) => a.esCorrecta),
      [false, false, true],
    );
  });

  it('marcar la que ya estaba marcada la deja marcada', () => {
    const despues = marcarCorrecta(buena().alternativas, 0);
    assert.equal(despues.filter((a) => a.esCorrecta).length, 1);
  });

  it('nunca deja dos correctas', () => {
    let alternativas = [
      { texto: 'a', esCorrecta: false },
      { texto: 'b', esCorrecta: false },
      { texto: 'c', esCorrecta: false },
    ];
    for (const i of [0, 1, 2, 1, 0]) {
      alternativas = marcarCorrecta(alternativas, i);
      assert.equal(alternativas.filter((a) => a.esCorrecta).length, 1);
    }
  });
});

describe('quitar una alternativa', () => {
  it('borrar la correcta deja la pregunta SIN correcta', () => {
    // No se hereda la marca. Si la interfaz eligiera, estaría decidiendo la
    // respuesta buena de un examen por su cuenta.
    const alternativas = [
      { texto: 'a', esCorrecta: true },
      { texto: 'b', esCorrecta: false },
      { texto: 'c', esCorrecta: false },
    ];
    const despues = sinAlternativa(alternativas, 0);
    assert.equal(despues.length, 2);
    assert.equal(despues.filter((a) => a.esCorrecta).length, 0);
  });

  it('no se baja del mínimo', () => {
    const alternativas = buena().alternativas;
    assert.equal(sinAlternativa(alternativas, 0).length, MINIMO_DE_ALTERNATIVAS);
  });
});

describe('añadir una alternativa', () => {
  it('llega vacía y sin marcar', () => {
    const despues = conAlternativaNueva(buena().alternativas);
    assert.equal(despues.length, 3);
    assert.equal(despues[2]?.texto, '');
    assert.equal(despues[2]?.esCorrecta, false);
  });

  it('no se pasa del máximo', () => {
    let alternativas = buena().alternativas;
    for (let i = 0; i < 10; i += 1) alternativas = conAlternativaNueva(alternativas);
    assert.equal(alternativas.length, MAXIMO_DE_ALTERNATIVAS);
  });
});

describe('cuándo se puede publicar', () => {
  it('una evaluación bien formada sí', () => {
    assert.equal(motivoParaNoPublicar([buena()]), null);
  });

  it('sin preguntas, no', () => {
    assert.equal(motivoParaNoPublicar([]), 'quiz_without_questions');
  });

  it('con una pregunta sin enunciado, no', () => {
    const p = { ...buena(), enunciado: '   ' };
    assert.equal(motivoParaNoPublicar([p]), 'quiz_prompt_empty');
  });

  it('con una alternativa vacía, no', () => {
    const p = buena();
    p.alternativas[1] = { texto: '  ', esCorrecta: false };
    assert.equal(motivoParaNoPublicar([p]), 'quiz_option_empty');
  });

  it('sin correcta o con dos, no', () => {
    const sinCorrecta = buena();
    sinCorrecta.alternativas = sinCorrecta.alternativas.map((a) => ({
      ...a,
      esCorrecta: false,
    }));
    assert.equal(motivoParaNoPublicar([sinCorrecta]), 'quiz_answer_missing');

    const dos = buena();
    dos.alternativas = dos.alternativas.map((a) => ({ ...a, esCorrecta: true }));
    assert.equal(motivoParaNoPublicar([dos]), 'quiz_answer_missing');
  });

  it('con una sola alternativa, no', () => {
    const p = buena();
    p.alternativas = [{ texto: 'única', esCorrecta: true }];
    assert.equal(motivoParaNoPublicar([p]), 'quiz_option_count_invalid');
  });

  it('una pregunta nueva no se puede publicar todavía', () => {
    assert.notEqual(motivoParaNoPublicar([preguntaNueva()]), null);
  });
});

describe('reordenar preguntas', () => {
  it('mueve la pregunta al sitio pedido', () => {
    assert.deepEqual(moverPregunta(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
    assert.deepEqual(moverPregunta(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
  });

  it('un movimiento imposible no cambia nada', () => {
    for (const [desde, hacia] of [
      [0, 0],
      [-1, 1],
      [0, 9],
      [9, 0],
    ] as Array<[number, number]>) {
      assert.deepEqual(moverPregunta(['a', 'b', 'c'], desde, hacia), ['a', 'b', 'c']);
    }
  });
});

describe('cambios sin guardar', () => {
  const base = { titulo: 'Final', notaMinima: 70, preguntas: [buena()] };

  it('sin tocar nada, no hay cambios', () => {
    assert.equal(hayCambiosSinGuardar(base, { ...base, preguntas: [buena()] }), false);
  });

  it('escribir el mismo texto con espacios tampoco cuenta', () => {
    const conEspacios = { ...base, titulo: '  Final  ' };
    assert.equal(
      hayCambiosSinGuardar(conEspacios, { ...base, preguntas: [buena()] }),
      false,
    );
  });

  it('cambiar la correcta SÍ cuenta', () => {
    const otra = buena();
    otra.alternativas = marcarCorrecta(otra.alternativas, 1);
    assert.equal(hayCambiosSinGuardar({ ...base, preguntas: [otra] }, base), true);
  });

  it('cambiar la nota mínima también', () => {
    assert.equal(hayCambiosSinGuardar({ ...base, notaMinima: 80 }, base), true);
  });
});

describe('la nota mínima', () => {
  it('va del 1 al 100', () => {
    for (const v of [1, 50, 100]) assert.equal(notaMinimaValida(v), true, String(v));
    for (const v of [0, -1, 101, 70.5, Number.NaN]) {
      assert.equal(notaMinimaValida(v), false, String(v));
    }
  });
});

describe('lo que la pantalla sostiene', () => {
  const BLOQUE = new RegExp('/\\*[\\s\\S]*?\\*/', 'g');
  const LINEA = new RegExp('//[^\\n]*', 'g');
  const PANTALLA = fuente('screens/EditarEvaluacionScreen.tsx')
    .replace(BLOQUE, ' ')
    .replace(LINEA, ' ');

  it('publicar pide confirmación y no se dispara dos veces', () => {
    const cuerpo = PANTALLA.slice(PANTALLA.indexOf('const publicar ='));
    assert.ok(cuerpo.includes('confirm('));
    const cerrojo = cuerpo.indexOf('publicandoRef.current = true');
    assert.ok(cerrojo !== -1 && cerrojo < cuerpo.indexOf('await'));
  });

  it('guardar tampoco', () => {
    const cuerpo = PANTALLA.slice(
      PANTALLA.indexOf('const guardar ='),
      PANTALLA.indexOf('const publicar ='),
    );
    const cerrojo = cuerpo.indexOf('guardandoRef.current = true');
    assert.ok(cerrojo !== -1 && cerrojo < cuerpo.indexOf('await'));
  });

  it('un fallo al guardar no borra lo escrito', () => {
    const cuerpo = PANTALLA.slice(
      PANTALLA.indexOf('const guardar ='),
      PANTALLA.indexOf('const publicar ='),
    );
    const captura = cuerpo.slice(cuerpo.indexOf('} catch'));
    assert.ok(!captura.includes('setBorrador(vacio'));
  });

  it('salir con cambios sin guardar avisa', () => {
    const cuerpo = PANTALLA.slice(PANTALLA.indexOf('const salir ='));
    assert.ok(cuerpo.includes('sinGuardar'));
    assert.ok(cuerpo.includes('destructive: true'));
  });

  it('publicar guarda antes: no se publica a ciegas', () => {
    const cuerpo = PANTALLA.slice(PANTALLA.indexOf('const publicar ='));
    const guardaAntes = cuerpo.indexOf('await guardar()');
    const publica = cuerpo.indexOf('QuizAutorRepository.publicar');
    assert.ok(guardaAntes !== -1 && guardaAntes < publica);
  });

  it('no se ofrece publicar mientras falte algo', () => {
    assert.ok(PANTALLA.includes('disabled={bloqueo !== null'));
  });

  it('el curso sin evaluación NO es un error', () => {
    // Es la pantalla que existe justo para crearla.
    assert.ok(PANTALLA.includes("=== 'course_quiz_not_found'"));
  });
});

describe('los tres idiomas dicen todo lo que el editor pregunta', () => {
  it('ninguna clave usada aquí falta en es, en o pt', () => {
    const usadas = [
      ...new Set(
        fuente('screens/EditarEvaluacionScreen.tsx').match(
          new RegExp("t\\('([a-zA-Z._]+)'", 'g'),
        ) ?? [],
      ),
    ].map((m) => m.slice(3, -1));

    assert.ok(usadas.length > 10, 'no se encontraron claves, la búsqueda falla');
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

  it('cada motivo de bloqueo tiene su texto', () => {
    for (const codigo of [
      'quiz_without_questions',
      'quiz_prompt_empty',
      'quiz_option_count_invalid',
      'quiz_option_empty',
      'quiz_answer_missing',
    ]) {
      for (const [nombre, diccionario] of [
        ['es', es],
        ['en', en],
        ['pt', pt],
      ] as Array<[string, Record<string, string>]>) {
        const clave = `editorEvaluacion.bloqueo.${codigo}`;
        assert.ok((diccionario[clave] ?? '').trim() !== '', `falta ${clave} en ${nombre}`);
      }
    }
  });
});
