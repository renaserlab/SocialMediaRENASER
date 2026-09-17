import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

/**
 * El codigo SIN comentarios.
 *
 * Hace falta porque estas comprobaciones buscan rastros como «valoracion» o
 * «duracion», y el propio fichero los NOMBRA en su cabecera para explicar por
 * que no se pintan. Buscando sobre el texto entero, la prueba se caia con el
 * comentario que documenta justo lo que ella vigila.
 */
const BLOQUE = new RegExp('/\\*[\\s\\S]*?\\*/', 'g');
const LINEA = new RegExp('//[^\\n]*', 'g');

function sinComentarios(codigo: string): string {
  return codigo.replace(BLOQUE, ' ').replace(LINEA, ' ');
}

const PORTADA_ENTERA = fuente('screens/CursosScreen.tsx');
const PORTADA = sinComentarios(PORTADA_ENTERA);
const REPOSITORIO = fuente('repositories/LearningRepository.ts');
const ACCESOS = fuente('components/AccesosAVerticales.tsx');

/**
 * LA PORTADA DE CURSOS NO PUEDE ENSEÑAR LO QUE EL SERVIDOR NO SABE.
 *
 * La referencia trae estrellas, «4.9 (1.2k)», número de alumnos, duración y una
 * fila de objetivos. Nada de eso existe en el modelo —`ReviewRead` no tiene
 * puntuación, no hay taxonomía de objetivos y el catálogo no devuelve
 * duración—, así que pintarlo sería inventarlo. Es exactamente el modo de fallo
 * contra el que existe `docs/Z_MATRIZ_DE_VISTAS.md`: dar una vista por terminada
 * porque se parece a la captura.
 *
 * Es una prueba de TEXTO, como las de garantía: aquí no hay renderizador. No
 * pretende ser una prueba de comportamiento, es un cerrojo.
 */
describe('lo que la portada de Cursos NO enseña', () => {
  it('no pinta valoración de ninguna forma', () => {
    /*
      ACTUALIZADA: «star» ya no se busca como un trozo de texto cualquiera.
      Buscándolo suelto, `alignItems: 'flex-start'` lo contiene, y la prueba se
      ponía roja al arreglar la fila de filtros —que no tiene nada que ver con
      pintar estrellas—. Era una falsa alarma del cerrojo, no un hallazgo.

      El patrón exige inicio de palabra y descarta lo que sigue con «t»
      («flex-start», «startTime»). Sigue cazando lo que de verdad importa:
      `name="star"`, `star-outline`, `starRating` o `stars`.
    */
    const rastros: readonly (string | RegExp)[] = [
      /\bstar(?!t)/i,
      'rating',
      'valoracion',
      'Valoración',
      '★',
    ];
    for (const rastro of rastros) {
      const aparece =
        typeof rastro === 'string' ? PORTADA.includes(rastro) : rastro.test(PORTADA);
      assert.ok(
        !aparece,
        `«${rastro}» en la portada: no hay puntuación en el modelo, así que ` +
          'cualquier estrella sería inventada.',
      );
    }
  });

  it('no pinta número de alumnos ni duración', () => {
    for (const rastro of ['alumnos', 'students', 'duracion', 'duration', 'lessonsTotal']) {
      assert.ok(
        !PORTADA.includes(rastro),
        `«${rastro}» en la portada: el catálogo no devuelve ese dato.`,
      );
    }
  });

  it('sí pinta el precio, que es columna real', () => {
    assert.ok(PORTADA_ENTERA.includes('etiquetaDePrecio(curso.priceMinor, curso.currency)'));
  });

  it('el progreso lo dice el servidor, no se calcula aquí', () => {
    // Deducirlo de lecciones vistas es como se acaba enseñando un número
    // distinto en cada pantalla.
    assert.ok(PORTADA_ENTERA.includes('curso.progressPercent'));
    assert.ok(
      !/lessonsCompleted\s*\/\s*lessonsTotal/.test(PORTADA),
      'el porcentaje no se calcula en el cliente.',
    );
  });
});

describe('la búsqueda y el filtro van al servidor', () => {
  it('el texto y el nivel viajan como parámetros', () => {
    /*
      Filtrando en el cliente sobre la página que llega, pedir «avanzado»
      devuelve los avanzados QUE HUBIERA en los primeros veinticuatro y la
      pantalla jura que no hay más.
    */
    assert.ok(REPOSITORIO.includes('partes.push(`q=${encodeURIComponent('));
    assert.ok(REPOSITORIO.includes('partes.push(`level=${filtros.nivel}`)'));
    assert.ok(
      PORTADA_ENTERA.includes('LearningRepository.listCourses(24, { texto: textoAplicado, nivel })'),
      'la portada tiene que mandar los filtros, no aplicarlos sobre el resultado.',
    );
    assert.ok(
      !/catalogo\.filter\(/.test(PORTADA),
      'nada de filtrar la lista ya recibida.',
    );
  });

  it('no se busca con cada tecla', () => {
    // Escribir «liderazgo» serían nueve peticiones y ocho respuestas que llegan
    // tarde y se pisan: la lista parpadea y puede acabar enseñando los
    // resultados de «liderazg».
    assert.ok(PORTADA_ENTERA.includes('setTimeout(() => setTextoAplicado(texto), 500)'));
    assert.ok(
      PORTADA_ENTERA.includes('return () => clearTimeout(espera);'),
      'la espera pendiente se cancela al teclear otra vez.',
    );
  });

  it('no se ofrece filtrar por lo que no se puede filtrar', () => {
    // Duración: no hay columna. Garantía: son 168 horas para todos, así que no
    // separaría nada. Objetivo: no hay taxonomía.
    for (const inexistente of ['duracion', 'garantia', 'objetivo']) {
      assert.ok(
        !PORTADA.toLowerCase().includes(`cursos.filtro.${inexistente}`),
        `se ofrece filtrar por ${inexistente} y el servidor no sabe hacerlo.`,
      );
    }
  });
});

describe('la fila de filtros son píldoras, no columnas', () => {
  /*
    LO QUE SE REPORTÓ. «Las casillas de filtro salen alargadas»: «Todos»,
    «Principiante», «Intermedio» y «Avanzado» se veían como cuatro columnas
    altísimas. Es el mismo defecto ya arreglado en `AccesosAVerticales`: un
    `ScrollView` trae `flexGrow: 1` de serie, aquí es hermano del contenido
    dentro de una columna con alto libre (`AppScreen` pone `flexGrow: 1` en su
    contenedor) y los dos se repartían el hueco; y en una fila el eje cruzado
    es el vertical, así que cada filtro se estiraba con el carril.
  */
  it('el carril no crece con el hueco que le sobra a la pantalla', () => {
    assert.ok(
      /carrilDeNiveles:\s*\{\s*flexGrow:\s*0\s*\}/.test(PORTADA_ENTERA),
      'sin `flexGrow: 0` el carril se queda con la mitad del alto libre.',
    );
    assert.ok(
      /style=\{styles\.carrilDeNiveles\}/.test(PORTADA_ENTERA),
      'y el estilo tiene que estar puesto en el ScrollView, no solo declarado.',
    );
  });

  it('y los filtros no se estiran con él', () => {
    const niveles = PORTADA_ENTERA.match(/niveles:\s*\{[\s\S]*?\n {2}\}/);
    assert.ok(niveles, 'no se encuentra el estilo del contenido de la fila de filtros.');
    assert.match(
      niveles[0],
      /alignItems:\s*'flex-start'/,
      'sin `alignItems` en el contenedor del contenido, cada filtro crece hasta ' +
        'el alto del carril: eso es lo que los convertía en columnas.',
    );
  });

  it('el área táctil se declara en vez de depender de cuánto se estire', () => {
    const nivel = PORTADA_ENTERA.match(/\n {2}nivel:\s*\{[\s\S]*?\n {2}\}/);
    assert.ok(nivel, 'no se encuentra el estilo de la píldora de filtro.');
    assert.match(
      nivel[0],
      /minHeight:\s*(\d+)/,
      'una píldora que ya no se estira necesita su propia altura mínima, o el ' +
        'objetivo táctil queda a merced del relleno.',
    );
    // Los 44 del mínimo táctil: 40 de caja más el hitSlop vertical de cada una.
    assert.match(
      PORTADA_ENTERA,
      /hitSlop=\{\{\s*top:\s*6,\s*bottom:\s*6\s*\}\}/,
      'sin el hitSlop la caja de 40 se queda por debajo del mínimo de 44.',
    );
  });
});

describe('los accesos a las verticales', () => {
  it('las que no existen lo dicen, en vez de llevar a ninguna parte', () => {
    assert.ok(ACCESOS.includes("{ clave: 'servicios', icono: 'briefcase', ruta: null }"));
    assert.ok(
      ACCESOS.includes('alTocarNoDisponible(nombre)'),
      'tocar una vertical que no existe tiene que avisar, no navegar.',
    );
  });

  it('Productos ya lleva a su catálogo: tiene pantalla y API', () => {
    // Dejó de ser una vertical sin pantalla: `/productos` existe y llama a
    // `/products`. Su portada resuelve sola el caso de las migraciones sin
    // aplicar (`disponible: false`), así que no hace falta apagar el acceso.
    assert.ok(
      ACCESOS.includes("{ clave: 'productos', icono: 'shopping-bag', ruta: '/productos' }"),
    );
  });

  it('la fila horizontal está blindada contra el cambio de sección', () => {
    // Regla del proyecto: Explorar se pasa de pestaña con un gesto horizontal.
    assert.ok(ACCESOS.includes('<SinCambioDeSeccion>'));
  });
});

describe('guardar un curso', () => {
  it('el marcador responde al dedo y se deshace si falla', () => {
    assert.ok(
      PORTADA_ENTERA.includes('setIdsGuardados((previos) => {'),
      'se pinta antes de saber el resultado.',
    );
    assert.ok(
      new RegExp('catch \\(e\\) \\{[\\s\\S]*?setIdsGuardados').test(PORTADA_ENTERA),
      'y se revierte si la peticion falla.',
    );
  });

  it('dos toques seguidos no mandan dos peticiones', () => {
    assert.ok(PORTADA_ENTERA.includes('if (guardando.current.has(curso.id)) return;'));
    assert.ok(PORTADA_ENTERA.includes('guardando.current.add(curso.id)'));
    assert.ok(
      PORTADA_ENTERA.includes('guardando.current.delete(curso.id)'),
      'y el cerrojo se suelta, o el marcador queda muerto tras un fallo.',
    );
  });

  it('guardar y quitar van por la API, no a la tabla', () => {
    assert.ok(REPOSITORIO.includes('${API_V1}/catalog/courses/${courseId}/saved'));
    assert.ok(
      !PORTADA_ENTERA.includes("from('saved_") &&
        !REPOSITORIO.includes("from('saved_"),
      'nada de escribir la tabla desde el telefono.',
    );
  });
});
