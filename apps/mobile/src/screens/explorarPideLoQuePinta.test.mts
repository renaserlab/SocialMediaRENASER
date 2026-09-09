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
  // Los filtros que se añadieron después también son opcionales: quien no
  // indique nada sigue recibiendo exactamente lo de antes.
  const catalogo = fuente('repositories/CatalogRepository.ts');
  assert.ok(
    catalogo.includes("cuando: GrupoDeEventos = 'all',"),
    'la pantalla de Agenda los usa todos: sin indicar nada tiene que llegar lo mismo',
  );
  assert.ok(catalogo.includes('limite = 50,'));
  assert.ok(
    catalogo.includes('} = {},'),
    'los filtros tienen que ser opcionales',
  );
});

test('sin tope ni filtros, el catálogo de cursos no manda ningún parámetro', () => {
  /*
    `ProfileSection` llama a `listCourses()` y filtra por autor en el cliente:
    limitarle la lista le escondería cursos de esa persona.

    Y desde que existen los filtros del servidor, la regla es la misma para
    ellos: sin filtros, la petición tiene que ser LITERALMENTE la de siempre. Un
    `?q=` vacío colado cambiaría lo que ve todo el mundo en la pantalla de
    inicio.
  */
  const learning = fuente('repositories/LearningRepository.ts');
  assert.match(
    learning,
    /if \(limite\) partes\.push\(`limit=\$\{limite\}`\);/,
    'el tope solo se manda si lo hay.',
  );
  assert.match(
    learning,
    /const consulta = partes\.length > 0 \? `\?\$\{partes\.join\('&'\)\}` : '';/,
    'sin nada que mandar, la consulta va vacía.',
  );
  assert.ok(
    /if \(filtros\?\.texto\?\.trim\(\)\)/.test(learning),
    'el texto vacío no puede convertirse en un `q=` vacío.',
  );
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

// ---------------------------------------------------------------------------
// Los dos carruseles de recomendacion, sangrados igual
// ---------------------------------------------------------------------------

/*
  EL FALLO. «Personas para ti» se leia pegado al borde izquierdo mientras el
  resto de Explorar —«Tu siguiente paso», «Proximos eventos», «Comunidades»—
  empezaba a 16. Se vio en una captura y era facil de confundir con un problema
  de la pantalla; no lo era.

  La causa estaba DENTRO del propio componente, y era incoherente consigo mismo:

      <View>                                  <- sin margen
        <SectionTitle ... />                  <- a 0
        <Text style={styles.nota}>            <- nota: paddingHorizontal lg
        <FlashList contentContainerStyle={fila}>  <- fila: paddingHorizontal lg

  La nota y las tarjetas si lo llevaban; solo el titulo se quedo fuera. Su
  hermano `CursosParaTi` ya lo hacia bien, envolviendo el titulo.

  POR QUE EL MARGEN VA EN EL TITULO Y NO EN EL CONTENEDOR: el carrusel tiene que
  poder llegar al borde de la pantalla al desplazarse. Con el padding en el
  contenedor, las tarjetas se cortarian antes de llegar.
*/

test('los carruseles de recomendacion sangran su titulo', () => {
  for (const componente of ['PersonasParaTi', 'CursosParaTi']) {
    const codigo = readFileSync(join(SRC, `components/${componente}.tsx`), 'utf8');

    // El titulo va envuelto, no suelto.
    assert.match(
      codigo,
      /<View style=\{styles\.titulo\}>\s*<SectionTitle/,
      `${componente}: el titulo tiene que ir dentro de un View con margen, o se ` +
        'pega al borde mientras su propio contenido queda a 16',
    );

    // Y ese estilo existe y sangra de verdad.
    assert.match(
      codigo,
      /titulo: \{ paddingHorizontal: spacing\.lg \}/,
      `${componente}: falta el estilo del titulo`,
    );

    // El carrusel sigue pudiendo llegar al borde: el margen NO esta en el
    // contenedor de fuera.
    const fila = codigo.match(/fila: \{[^}]*\}/)?.[0] ?? '';
    assert.match(
      fila,
      /paddingHorizontal: spacing\.lg/,
      `${componente}: las tarjetas llevan su margen en el contenido, no en el ` +
        'contenedor, para poder desplazarse hasta el borde',
    );
  }
});
