import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Explorar pedía catálogos enteros para pintar tres filas, y encima esperaba.
 *
 * Sale de `docs/Z_MEDICION_MENSAJES_EXPLORE.md`, donde está medido:
 *
 *  - `GET /catalog/events?limit=50` devuelve **39 081 B** con la agenda llena,
 *    para rellenar DOS filas. Hoy son 5 511 B para dos filas.
 *  - `GET /catalog/courses` trae el catálogo para quedarse con `[0]`.
 *  - El `setTimeout` de 600 ms sumado a los 0,392 s que tarda `/catalog/events`
 *    daba **más de un segundo** de texto de relleno que después cambiaba de
 *    golpe. No era un esqueleto rellenándose: era contenido equivocado
 *    sustituyéndose, que es lo que se siente como lentitud aunque el servidor
 *    conteste rápido.
 *
 * Estas comprobaciones miran el CÓDIGO FUENTE, como las de
 * `cuadriculaSinReproductores`: montar la pantalla pediría un renderizador de
 * React Native que este proyecto no tiene en las pruebas, y lo que hay que
 * impedir es que vuelva a colarse una petición que trae de más.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. Pedir solo lo que se pinta
// ---------------------------------------------------------------------------

test('Explorar pide dos eventos, que son los que enseña', () => {
  const explorar = fuente('screens/ExploreScreen.tsx');
  assert.match(
    explorar,
    /CatalogRepository\.listEvents\('upcoming',\s*2\)/,
    'la sección pinta `nextEvents.slice(0, 2)`: pedir cincuenta es traer para tirar',
  );
});

test('Explorar pide un curso, que es el que enseña', () => {
  const explorar = fuente('screens/ExploreScreen.tsx');
  assert.match(explorar, /LearningRepository\.listCourses\(1\)/);
});

// ---------------------------------------------------------------------------
// 2. Sin romper a quien SÍ necesita la lista entera
// ---------------------------------------------------------------------------

test('el tope de eventos es opcional y por omisión pide lo de antes', () => {
  const catalogo = fuente('repositories/CatalogRepository.ts');
  assert.match(
    catalogo,
    /listEvents\(cuando: GrupoDeEventos = 'all', limite = 50\)/,
    'la pantalla de Agenda los usa todos: sin indicar nada tiene que llegar lo mismo',
  );
});

test('sin tope, el catálogo de cursos no manda el parámetro', () => {
  // `ProfileSection` llama a `listCourses()` y filtra por autor en el cliente:
  // limitarle la lista le escondería cursos de esa persona.
  const learning = fuente('repositories/LearningRepository.ts');
  assert.match(learning, /const consulta = limite \? `\?limit=\$\{limite\}` : '';/);
});

// ---------------------------------------------------------------------------
// 3. La espera de 600 ms
// ---------------------------------------------------------------------------

test('el catálogo destacado ya no espera medio segundo', () => {
  const explorar = fuente('screens/ExploreScreen.tsx');
  assert.ok(
    !/setTimeout\(\(\) => void cargarDestacados\(\)/.test(explorar),
    'la espera costaba más de un segundo de texto de relleno, y su motivo —un ' +
      'servidor recién despierto— desapareció al mover la API a AWS',
  );
  assert.match(explorar, /void cargarDestacados\(\);/);
});

test('sigue habiendo una sola llamada, y en paralelo', () => {
  // Lo que NO se toca: las cuatro peticiones van juntas en un
  // `Promise.allSettled`, y que una falle no tapa la pantalla entera.
  const explorar = fuente('screens/ExploreScreen.tsx');
  assert.match(explorar, /await Promise\.allSettled\(\[/);
  assert.match(explorar, /setCatalogoFallido\(fallos\.length === 3\)/);
});
