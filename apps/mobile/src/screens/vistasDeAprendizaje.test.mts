/**
 * Las vistas de aprendizaje, comprobadas sobre el CÓDIGO.
 *
 * Montar las pantallas pediría un renderizador de React Native que este
 * proyecto no tiene en las pruebas. Todo lo que SÍ se puede ejecutar —cuándo se
 * puede enviar, qué falta para terminar, cómo se lee un fallo— vive en
 * `lib/evaluacionDeCurso.ts` y se prueba allí, ejecutándolo de verdad.
 *
 * Aquí quedan las garantías que solo existen en el árbol de componentes, y cada
 * una se comprueba por su PROPIEDAD, no copiando una línea que dejaría de valer
 * al mover una coma.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const BLOQUE = new RegExp('/\\*[\\s\\S]*?\\*/', 'g');
const LINEA = new RegExp('//[^\\n]*', 'g');
const sinComentarios = (c: string) => c.replace(BLOQUE, ' ').replace(LINEA, ' ');

const EVALUACION = sinComentarios(fuente('screens/EvaluacionScreen.tsx'));
const COMPLETADO = sinComentarios(fuente('screens/CursoCompletadoScreen.tsx'));
const CERTIFICADO = sinComentarios(fuente('screens/CertificadoScreen.tsx'));
const VERIFICAR = sinComentarios(fuente('screens/VerificarCertificadoScreen.tsx'));
const BIBLIOTECA = sinComentarios(fuente('screens/LibraryScreen.tsx'));
const TEMARIO = sinComentarios(fuente('components/CourseContentEditor.tsx'));

describe('la evaluación no corrige en el teléfono', () => {
  it('no pinta ninguna opción como acertada', () => {
    // El servidor no manda cuál es la correcta: cualquier verde aquí sería
    // inventado.
    for (const palabra of ['isCorrect', 'esCorrecta', 'acierto', 'correcta ?']) {
      assert.ok(!EVALUACION.includes(palabra), `«${palabra}» no puede estar aquí`);
    }
  });

  it('la nota que enseña es la que vino del servidor', () => {
    assert.ok(EVALUACION.includes('intento.nota'));
    assert.ok(!EVALUACION.includes('setNota('));
  });

  it('se envía entera', () => {
    assert.ok(EVALUACION.includes('sePuedeEnviar('));
    assert.ok(EVALUACION.includes('disabled={!puedeEnviar'));
  });

  it('enviar pide confirmación', () => {
    assert.ok(EVALUACION.includes('confirm('));
    assert.ok(EVALUACION.includes("t('evaluacion.confirmarTitulo')"));
  });

  it('dos toques no envían dos veces ni abren dos intentos', () => {
    for (const [nombre, cuerpo] of [
      ['enviar', EVALUACION.slice(EVALUACION.indexOf('const enviar ='))],
      ['empezar', EVALUACION.slice(EVALUACION.indexOf('const empezar ='))],
    ] as Array<[string, string]>) {
      const cerrojo = cuerpo.indexOf('Ref.current = true');
      const primerAwait = cuerpo.indexOf('await');
      assert.ok(
        cerrojo !== -1 && cerrojo < primerAwait,
        `el cerrojo de ${nombre} tiene que echarse antes del primer await`,
      );
    }
  });

  it('sin la migración o sin evaluación, no se inventa una avería', () => {
    assert.ok(EVALUACION.includes('evaluacionNoMontada(fallo)'));
    assert.ok(EVALUACION.includes('sinEvaluacion(fallo)'));
  });
});

describe('curso completado', () => {
  it('el porcentaje sale del servidor, no de contar lecciones aquí', () => {
    assert.ok(COMPLETADO.includes('estado.porcentaje'));
    assert.ok(!COMPLETADO.includes('filter((l)'));
    assert.ok(!COMPLETADO.includes('100'), 'no se escribe un 100 a mano');
  });

  it('si no está terminado, se dice qué falta', () => {
    assert.ok(COMPLETADO.includes('loQueFalta('));
    assert.ok(COMPLETADO.includes("t('completado.faltaEvaluacion')"));
    assert.ok(COMPLETADO.includes("t('completado.faltanLecciones')"));
  });

  it('la nota solo si consta', () => {
    assert.ok(COMPLETADO.includes('estado.mejorNota !== null'));
  });
});

describe('el certificado', () => {
  it('no se llama título ni acreditación', () => {
    // Es un certificado de finalización de un curso. Cualquier otra palabra
    // afirmaría un reconocimiento oficial que no existe.
    for (const palabra of ['título profesional', 'titulo profesional', 'acredita']) {
      assert.ok(
        !CERTIFICADO.toLowerCase().includes(palabra.toLowerCase()),
        `«${palabra}» promete algo que esto no es`,
      );
    }
  });

  it('la dirección de verificación viene del servidor', () => {
    assert.ok(CERTIFICADO.includes('urlDeVerificacion'));
    // Componerla aquí terminaría con certificados apuntando a sitios distintos.
    assert.ok(!CERTIFICADO.includes('https://'));
  });

  it('uno revocado se enseña igual, marcado', () => {
    assert.ok(CERTIFICADO.includes("=== 'revoked'"));
    assert.ok(CERTIFICADO.includes("t('certificado.revocado')"));
  });

  it('se comparte el enlace, no una imagen inventada', () => {
    assert.ok(CERTIFICADO.includes('Share.share'));
    assert.ok(CERTIFICADO.includes('certificado.urlDeVerificacion'));
  });
});

describe('la verificación pública', () => {
  it('no pide sesión', () => {
    const REPO = sinComentarios(fuente('repositories/CertificateRepository.ts'));
    const verificar = REPO.slice(REPO.indexOf('async verificar('));
    assert.ok(verificar.includes('auth: false'));
  });

  it('no enseña nada que el servidor no mande', () => {
    for (const campo of ['email', 'correo', 'userId', 'orderId', 'amount', 'importe']) {
      assert.ok(
        !VERIFICAR.includes(campo),
        `«${campo}» no puede aparecer en una página pública`,
      );
    }
  });

  it('un código que no existe se explica', () => {
    assert.ok(VERIFICAR.includes('mensajeDeErrorDeCertificado'));
  });
});

describe('mis cursos', () => {
  it('tiene los tres estados de la captura', () => {
    for (const clave of [
      'biblioteca.enProgreso',
      'biblioteca.noIniciados',
      'biblioteca.finalizados',
    ]) {
      assert.ok(BIBLIOTECA.includes(clave), `falta ${clave}`);
    }
  });

  it('«continuar» solo cuando hay a dónde ir', () => {
    // Un curso terminado o sin lecciones no tiene siguiente: el servidor manda
    // `null` y ofrecer el botón llevaría a una pantalla que no existe.
    assert.ok(BIBLIOTECA.includes('curso.nextLessonId ? ('));
  });

  it('el porcentaje viene del servidor', () => {
    assert.ok(BIBLIOTECA.includes('curso.progressPercent'));
  });

  it('y la biblioteca ya se puede abrir desde Cursos', () => {
    const CURSOS = sinComentarios(fuente('screens/CursosScreen.tsx'));
    assert.ok(CURSOS.includes("'/library'"));
  });
});

describe('el temario con progreso', () => {
  it('el check sale de lo que el servidor dice que está hecho', () => {
    assert.ok(TEMARIO.includes('completadas?.has(lesson.id)'));
  });

  it('sin saberlo no se afirma que no está hecho', () => {
    // `completadas` sin definir dibuja el icono de siempre, no un círculo
    // vacío, que sería una afirmación.
    assert.ok(TEMARIO.includes("? 'check-circle'"));
    assert.ok(TEMARIO.includes('completadas && module.lessons.length > 0'));
  });

  it('el avance del curso no se recalcula aquí', () => {
    assert.ok(TEMARIO.includes('progresoDelCurso'));
    assert.ok(!TEMARIO.includes('Math.round(('), 'el porcentaje llega hecho');
  });
});
