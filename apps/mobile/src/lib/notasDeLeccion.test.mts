/**
 * Las notas privadas, comprobadas ejecutando las reglas de verdad.
 *
 * Lo que se prueba aquí es lo que se puede ejecutar sin montar React Native:
 * qué texto vale, cómo se lee el minuto y qué significa cada fallo. Las
 * garantías que solo viven en el árbol de componentes están al final, y cada
 * una se comprueba por su PROPIEDAD, no copiando una línea literal.
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
  LARGO_MAXIMO,
  mensajeDeErrorDeNota,
  minutoDeLaNota,
  notaValida,
  nuevaClaveDeGuardado,
  pestanaNoMontada,
} from './notasDeLeccion.ts';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const BLOQUE = new RegExp('/\\*[\\s\\S]*?\\*/', 'g');
const LINEA = new RegExp('//[^\\n]*', 'g');
const sinComentarios = (c: string) => c.replace(BLOQUE, ' ').replace(LINEA, ' ');

/** El traductor de las pruebas: devuelve la clave, así se ve cuál se usó. */
const t = ((clave: string) => clave) as never;

describe('qué texto vale como nota', () => {
  it('un texto normal vale', () => {
    assert.equal(notaValida('Aplicar esto al equipo'), true);
  });

  it('vacío o solo espacios no vale', () => {
    for (const texto of ['', ' ', '\n', '\t  \n']) {
      assert.equal(notaValida(texto), false, `«${texto}» no debería valer`);
    }
  });

  it('el tope es el mismo que el de la base', () => {
    assert.equal(LARGO_MAXIMO, 2000);
    assert.equal(notaValida('x'.repeat(2000)), true);
    assert.equal(notaValida('x'.repeat(2001)), false);
  });

  it('los espacios de los bordes no cuentan para el tope', () => {
    // Se guarda el texto recortado, así que medir sin recortar rechazaría una
    // nota que el servidor sí acepta.
    assert.equal(notaValida(`  ${'x'.repeat(2000)}  `), true);
  });
});

describe('el minuto de una nota', () => {
  it('se lee en m:ss', () => {
    assert.equal(minutoDeLaNota(522), '8:42');
    assert.equal(minutoDeLaNota(0), '0:00');
    assert.equal(minutoDeLaNota(59), '0:59');
    assert.equal(minutoDeLaNota(60), '1:00');
  });

  it('pasa a h:mm:ss cuando hace falta', () => {
    assert.equal(minutoDeLaNota(3600), '1:00:00');
    assert.equal(minutoDeLaNota(3661), '1:01:01');
  });

  it('sin posición no se inventa un cero', () => {
    // «0:00» diría que la nota se tomó al principio del vídeo, y lo que pasó
    // es que no había posición.
    assert.equal(minutoDeLaNota(null), null);
  });

  it('una posición imposible no se pinta', () => {
    assert.equal(minutoDeLaNota(-1), null);
    assert.equal(minutoDeLaNota(Number.NaN), null);
    assert.equal(minutoDeLaNota(Number.POSITIVE_INFINITY), null);
  });
});

describe('qué significa cada fallo', () => {
  it('la migración sin aplicar NO es un error', () => {
    assert.equal(pestanaNoMontada({ code: 'lesson_notes_not_available' }), true);
    assert.equal(pestanaNoMontada({ code: 'lesson_notes_access_required' }), false);
    assert.equal(pestanaNoMontada(new Error('se cayó la red')), false);
    assert.equal(pestanaNoMontada(null), false);
  });

  it('los códigos del servidor están traducidos', () => {
    assert.equal(
      mensajeDeErrorDeNota({ code: 'lesson_notes_access_required' }, t),
      'nota.necesitaAcceso',
    );
    assert.equal(mensajeDeErrorDeNota({ code: 'lesson_note_empty' }, t), 'nota.vacia');
  });

  it('un fallo sin código se explica con lo que dijo el servidor', () => {
    assert.equal(
      mensajeDeErrorDeNota(new Error('El curso ya no existe.'), t),
      'El curso ya no existe.',
    );
  });

  it('y si no dijo nada, se ofrece reintentar', () => {
    assert.equal(mensajeDeErrorDeNota(new Error('   '), t), 'common.tryAgain');
    assert.equal(mensajeDeErrorDeNota(undefined, t), 'common.tryAgain');
  });
});

describe('la clave de idempotencia', () => {
  it('cada apunte estrena la suya', () => {
    const claves = new Set(Array.from({ length: 200 }, () => nuevaClaveDeGuardado()));
    assert.equal(claves.size, 200, 'dos apuntes distintos no pueden compartir clave');
  });

  it('no viene vacía', () => {
    assert.ok(nuevaClaveDeGuardado().trim().length > 4);
  });
});

describe('lo que el árbol de componentes sostiene', () => {
  const COMPONENTE = sinComentarios(fuente('components/NotasDeLaLeccion.tsx'));
  const REPOSITORIO = sinComentarios(fuente('repositories/LessonNoteRepository.ts'));
  const PANTALLA = sinComentarios(fuente('screens/LessonScreen.tsx'));

  it('no hay forma de compartir ni publicar una nota', () => {
    // Es la propiedad entera de esta función: si aparece un botón de compartir,
    // deja de ser un apunte privado.
    for (const palabra of ['Share', 'compartir', 'publicar', 'publish']) {
      assert.ok(
        !COMPONENTE.toLowerCase().includes(palabra.toLowerCase()),
        `«${palabra}» no puede existir en una nota privada`,
      );
    }
  });

  it('el repositorio no acepta el identificador de nadie', () => {
    // Quien pregunta sale del token. Un parámetro de usuario aquí sería una
    // invitación a pedir las de otro.
    assert.ok(!REPOSITORIO.includes('userId'));
    assert.ok(!REPOSITORIO.includes('user_id'));
  });

  it('guardar manda una clave de idempotencia', () => {
    assert.ok(REPOSITORIO.includes('Idempotency-Key'));
    assert.ok(COMPONENTE.includes('nuevaClaveDeGuardado'));
  });

  it('un doble toque no guarda dos veces', () => {
    // El cerrojo tiene que echarse ANTES del primer `await`.
    const cuerpo = COMPONENTE.slice(COMPONENTE.indexOf('const guardar ='));
    const cerrojo = cuerpo.indexOf('guardandoRef.current = true');
    const primerAwait = cuerpo.indexOf('await');
    assert.ok(cerrojo !== -1 && cerrojo < primerAwait);
  });

  it('borrar pide confirmación', () => {
    assert.ok(COMPONENTE.includes('confirm('));
    assert.ok(COMPONENTE.includes('destructive: true'));
  });

  it('un fallo al guardar no borra lo que se acababa de escribir', () => {
    const guardar = COMPONENTE.slice(
      COMPONENTE.indexOf('const guardar ='),
      COMPONENTE.indexOf('const retirar ='),
    );
    const captura = guardar.slice(guardar.indexOf('} catch'));
    assert.ok(!captura.includes("setBorrador('')"));
  });

  it('sin la migración la pestaña no se pinta y no se dice nada', () => {
    assert.ok(COMPONENTE.includes('if (pestanaNoMontada(fallo)) return null'));
  });

  it('la lección ofrece las tres pestañas de la captura', () => {
    for (const clave of ['lesson.description', 'lesson.tabResources', 'lesson.tabNotes']) {
      assert.ok(PANTALLA.includes(clave), `falta la pestaña ${clave}`);
    }
  });

  it('sin acceso no se ofrece apuntar', () => {
    assert.ok(PANTALLA.includes('lesson.hasAccess'));
  });

  it('la lección se puede dar por terminada a mano', () => {
    // El vídeo la cierra solo al llegar al final, pero una lección puede ser
    // texto o verse fuera de la aplicación.
    assert.ok(PANTALLA.includes('completeLesson'));
    assert.ok(PANTALLA.includes('lesson.markComplete'));
  });
});

describe('los tres idiomas dicen todo lo que las notas preguntan', () => {
  it('ninguna clave usada aquí falta en es, en o pt', () => {
    const usadas = [
      ...new Set(
        [
          fuente('components/NotasDeLaLeccion.tsx'),
          fuente('lib/notasDeLeccion.ts'),
        ]
          .join('\n')
          .match(new RegExp("t\\('([a-zA-Z.]+)'", 'g')) ?? [],
      ),
    ].map((m) => m.slice(3, -1));

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
