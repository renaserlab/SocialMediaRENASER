import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * El perfil de otra persona no habla en segunda persona, y enseña lo suyo.
 *
 * DOS FALLOS EN LA MISMA PANTALLA, y el segundo es el grave.
 *
 *  1. La sección de Cursos de un perfil ajeno decía «Aún no TIENES cursos» y
 *     ofrecía un botón «Ver cursos de Z». El texto le hablaba de sí mismo a
 *     quien está visitando el perfil de OTRA persona, porque era el mismo
 *     texto que se escribió para el perfil propio.
 *
 *  2. La condición que llevaba a ese aviso NO MIRABA SI HABÍA CONTENIDO. Le
 *     faltaba `items.length === 0`, así que en cualquier perfil ajeno se
 *     devolvía el aviso ANTES de llegar a pintar la lista: los cursos de otra
 *     persona no se veían nunca, publicara los que publicara. El comentario
 *     que ya había en el código decía «cuando aquí no hay nada que enseñar»;
 *     era la condición la que no lo comprobaba.
 *
 * Estas comprobaciones miran el CÓDIGO FUENTE y no la pantalla, como las de
 * `cuadriculaSinReproductores`: montar la vista pediría un renderizador de
 * React Native que este proyecto no tiene en las pruebas, y lo que hay que
 * impedir es que una condición vuelva a olvidarse de mirar si hay algo.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

/** El bloque del aviso de perfil ajeno, desde su `if` hasta el cierre. */
function bloqueDelAvisoAjeno(): string {
  const seccion = fuente('components/ProfileSection.tsx');
  const inicio = seccion.indexOf("kind !== 'podcast' &&");
  assert.notEqual(inicio, -1, 'no se encontró la condición del aviso de perfil ajeno');
  // Hasta el siguiente `if (` de primer nivel: suficiente para aislarlo.
  const fin = seccion.indexOf('\n  if (', inicio + 1);
  return seccion.slice(inicio, fin === -1 ? seccion.length : fin);
}

// ---------------------------------------------------------------------------
// 1. El fallo grave: el aviso se daba sin mirar si había cursos
// ---------------------------------------------------------------------------

test('el aviso de perfil ajeno exige que no haya nada que enseñar', () => {
  assert.match(
    bloqueDelAvisoAjeno(),
    /items\.length === 0/,
    'sin esta comprobación, los cursos de otra persona no se ven nunca',
  );
});

test('`items` se calcula antes del aviso, no después', () => {
  const seccion = fuente('components/ProfileSection.tsx');
  const declaracion = seccion.indexOf("const items = kind === 'eventos'");
  const condicion = seccion.indexOf("kind !== 'podcast' &&");
  assert.notEqual(declaracion, -1, 'falta la declaración de `items`');
  assert.ok(
    declaracion < condicion,
    'el aviso necesita saber si hay contenido: `items` tiene que estar antes',
  );
  // Una sola vez. Dos declaraciones fueron el error al subirla de sitio.
  const veces = seccion.split("const items = kind === 'eventos'").length - 1;
  assert.equal(veces, 1, '`items` está declarada más de una vez');
});

// ---------------------------------------------------------------------------
// 2. Ni el texto en segunda persona ni el botón al catálogo
// ---------------------------------------------------------------------------

test('el aviso de perfil ajeno no usa los textos del perfil propio', () => {
  const bloque = bloqueDelAvisoAjeno();
  for (const clave of ['section.noCourses', 'section.noEvents', 'section.noCoursesBody']) {
    assert.ok(
      !bloque.includes(clave),
      `${clave} está escrito en segunda persona: es del perfil propio`,
    );
  }
  assert.match(bloque, /section\.otherNoCourses/);
  assert.match(bloque, /section\.otherNoEvents/);
});

test('el aviso de perfil ajeno no ofrece «Ver cursos de Z»', () => {
  const bloque = bloqueDelAvisoAjeno();
  assert.ok(
    !bloque.includes('section.goToCourses') && !bloque.includes('section.goToEvents'),
    'el catálogo de la comunidad no se ofrece desde el perfil de otra persona',
  );
  assert.ok(
    !/<Button/.test(bloque),
    'ese aviso no lleva ningún botón',
  );
});

/*
  LA MISMA MEZCLA, AHORA EN CURSOS.

  Con reseñas se corrigio el perfil AJENO. En cursos el problema quedaba en el
  PROPIO: debajo de «+ Agregar curso» aparecia «Ver cursos de Z», que lleva al
  perfil del administrador. En tu propia seccion de cursos eso mezcla dos
  mensajes que no son el mismo:

      «todavia no has publicado ningun curso»   habla de ti
      «mira los cursos de Z»                    habla de otra persona

  El estado vacio se queda. La salida al catalogo se va: los cursos ajenos se
  descubren desde Explorar, que es la superficie hecha para eso.

  Podcast y Eventos conservan la salida porque ahi el contenido ES de Z y no
  tuyo, asi que no compite con nada propio.
*/

test('mi perfil → cursos NO ofrece «Ver cursos de Z»', () => {
  const seccion = fuente('components/ProfileSection.tsx');

  // La lista es explicita, no se deduce de ADMIN_SECTIONS.
  const lista = seccion.match(
    /const CATALOGO_DE_Z_DESDE_MI_PERFIL[^=]*=\s*new Set\(\[([^\]]*)\]/,
  );
  assert.ok(lista, 'falta CATALOGO_DE_Z_DESDE_MI_PERFIL');
  assert.ok(
    !/'cursos'/.test(lista[1]),
    `cursos no debe ofrecer salida al catalogo desde el perfil propio. Lista: ${lista[1]}`,
  );
});

test('el boton del catalogo consulta esa lista, no solo ADMIN_SECTIONS', () => {
  const seccion = fuente('components/ProfileSection.tsx');
  // Sin esta condicion el boton vuelve a salir en cursos.
  assert.match(
    seccion,
    /ADMIN_SECTIONS\[kind\] && CATALOGO_DE_Z_DESDE_MI_PERFIL\.has\(kind\)/,
    'el boton tiene que exigir ademas que la seccion tenga catalogo de Z',
  );
});

test('podcast y eventos conservan su salida al catalogo', () => {
  const seccion = fuente('components/ProfileSection.tsx');
  const lista = seccion.match(
    /const CATALOGO_DE_Z_DESDE_MI_PERFIL[^=]*=\s*new Set\(\[([^\]]*)\]/,
  );
  assert.ok(lista);
  assert.match(lista[1], /'podcast'/, 'podcast tenia un caso legitimo');
  assert.match(lista[1], /'eventos'/, 'eventos tenia un caso legitimo');
  // Y el boton sigue existiendo en el codigo, no se borro la funcion entera.
  assert.match(seccion, /ADMIN_SECTIONS\[kind\]!\.action/);
  assert.match(seccion, /openAdminSection\(kind\)/);
});

test('el estado vacio de mis cursos sobrevive a quitar el boton', () => {
  /*
    Lo que se quito es la salida al catalogo, no el aviso. Si al separarlos se
    hubiera perdido el texto, la seccion vacia quedaria muda.
  */
  const seccion = fuente('components/ProfileSection.tsx');
  assert.match(seccion, /section\.noneOwnCourses/);
  // Y se pinta cuando NO hay nada tuyo, independientemente del catalogo.
  assert.match(seccion, /items\.length === 0 \|\| CATALOGO_DE_Z_DESDE_MI_PERFIL\.has\(kind\)/);
});

test('«+ Agregar curso» sigue en pie', () => {
  const seccion = fuente('components/ProfileSection.tsx');
  assert.match(seccion, /setCreating\(true\)/, 'el alta de curso no puede haberse perdido');
  assert.match(seccion, /icon="plus"/);
});

// ---------------------------------------------------------------------------
// 3. Los textos existen en los tres idiomas
// ---------------------------------------------------------------------------

test('los textos del perfil ajeno están en español, inglés y portugués', () => {
  for (const idioma of ['es', 'en', 'pt']) {
    const diccionario = fuente(`i18n/${idioma}.ts`);
    for (const clave of ['section.someone', 'section.otherNoCourses', 'section.otherNoEvents']) {
      assert.ok(diccionario.includes(`'${clave}'`), `falta ${clave} en ${idioma}.ts`);
    }
    // Con el nombre dentro de la frase: el orden de las palabras cambia entre
    // idiomas y concatenar «nombre + texto» produce frases rotas.
    assert.match(
      diccionario,
      /'section\.otherNoCourses': '[^']*\{name\}[^']*'/,
      `en ${idioma}.ts el nombre tiene que ir dentro de la frase`,
    );
  }
});
