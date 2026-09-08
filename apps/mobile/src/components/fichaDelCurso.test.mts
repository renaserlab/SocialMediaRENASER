import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

// Sin comentarios: el propio fichero NOMBRA «valoración» y «alumnos» para
// explicar por qué no los pinta.
const BLOQUE = new RegExp('/\\*[\\s\\S]*?\\*/', 'g');
const LINEA = new RegExp('//[^\\n]*', 'g');
const sinComentarios = (c: string) => c.replace(BLOQUE, ' ').replace(LINEA, ' ');

const FICHA_ENTERA = fuente('components/FichaDelCurso.tsx');
const FICHA = sinComentarios(FICHA_ENTERA);
const DETALLE = fuente('screens/CourseScreen.tsx');
const HOOK = fuente('hooks/useCourse.ts');

/**
 * La ficha del curso enseña lo que el servidor manda, y solo eso.
 *
 * El detalle no pintaba nada de la ficha ampliada aunque el backend ya la
 * devolvía: ni aprendizajes, ni público objetivo, ni requisitos, ni idioma, ni
 * nivel, ni duración.
 */
describe('la ficha del curso', () => {
  it('cada bloque aparece solo si viene del servidor', () => {
    assert.ok(FICHA.includes('if (course.level) {'), 'sin nivel no se pinta nivel.');
    assert.ok(
      FICHA.includes('if (duracionSegundos > 0) {'),
      'sin duración no se pinta duración.',
    );
    assert.ok(
      FICHA.includes('.filter((l) => l.puntos.length > 0)'),
      'una lista vacía no deja un título huérfano.',
    );
    assert.ok(
      FICHA.includes('if (datos.length === 0 && listas.length === 0) return null;'),
      'sin nada que decir, la ficha no ocupa sitio.',
    );
  });

  it('no inventa valoración ni alumnos', () => {
    for (const rastro of ['rating', 'estrella', 'alumnos', 'students', '★']) {
      assert.ok(!FICHA.includes(rastro), `«${rastro}» no existe en el modelo.`);
    }
  });

  it('la duración la suma el servidor, no la pantalla', () => {
    /*
      Sumándola aquí, la ficha y la vista previa del asistente sumarían por su
      cuenta y un día dirían cosas distintas.
    */
    assert.ok(HOOK.includes('setDurationSecondsTotal(detail.durationSecondsTotal)'));
    assert.ok(
      DETALLE.includes('duracionSegundos={durationSecondsTotal}'),
      'el detalle pasa la que da el servidor.',
    );
    assert.ok(
      !/lessons\.reduce\([^)]*durationSeconds/.test(DETALLE),
      'nada de sumar las lecciones en el cliente.',
    );
  });

  it('el detalle la pinta', () => {
    assert.ok(DETALLE.includes('<FichaDelCurso course={course}'));
  });
});
