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
      PORTADA_ENTERA.includes('LearningRepository.listCourses(24, { texto: textoAplicado, nivel, ...filtrosAdicionales })'),
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
    /*
      Los filtros son ahora la píldora de toda la aplicación (`Chip`), y es
      ELLA la que declara su altura: 44, el mínimo táctil, sin `hitSlop` que
      lo complete ni caja que dependa de cuánto se estire el carril.
    */
    const chip = fuente('components/Chip.tsx');
    const base = chip.match(/\n {2}base:\s*\{[\s\S]*?\n {2}\}/);
    assert.ok(base, 'no se encuentra el estilo de la píldora.');
    const alto = Number(/minHeight:\s*(\d+)/.exec(base[0])?.[1]);
    assert.ok(alto >= 44, `la píldora mide ${alto}: por debajo del mínimo táctil.`);
    assert.match(PORTADA, /<Chip\s+key=\{cual \?\? 'todos'\}[\s\S]*?selected=\{activo\}[\s\S]*?rol="radio"/);
  });
});

describe('la portada de Cursos se ve entera aunque falten imágenes', () => {
  /*
    Visto el 05/10/2026 al revisar la portada con datos: un curso sin imagen
    pintaba una caja del color de la superficie —blanco sobre blanco—, los
    títulos de sección quedaban pegados al borde de la pantalla y los filtros
    eran un dibujo distinto del de Eventos.
  */
  it('un curso sin portada enseña un hueco que se ve, no una caja del color del fondo', () => {
    assert.ok(!/styles\.(portada|miniatura), \{ backgroundColor: colors\.surface \}/.test(PORTADA));
    assert.equal(PORTADA.match(/<PortadaVacia icono="book-open"/g)?.length, 3, 'rejilla, guardados y en curso');
    const hueco = sinComentarios(fuente('components/PortadaVacia.tsx'));
    assert.match(hueco, /backgroundColor: colors\.surfaceAlt/);
    assert.match(hueco, /<Feather name=\{icono\} size=\{tamano\} color=\{colors\.textMuted\} \/>/);
    // Sale del tema: ningún color escrito a mano.
    assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(hueco));
  });

  it('los títulos de sección van alineados con lo que titulan', () => {
    assert.match(PORTADA_ENTERA, /tituloDeSeccion:\s*\{\s*paddingHorizontal:\s*spacing\.md\s*\}/);
    assert.equal(
      PORTADA.match(/<View style=\{styles\.tituloDeSeccion\}>\s*<SectionTitle /g)?.length,
      3,
      'continúa aprendiendo, guardados y todo el catálogo',
    );
    assert.ok(!/\n\s*<SectionTitle title=\{t\('cursos\./.test(PORTADA.replace(/<View style=\{styles\.tituloDeSeccion\}>\s*<SectionTitle /g, '')));
  });

  it('todo lo que se toca responde al dedo como en el resto de la aplicación', () => {
    assert.ok(!/<Pressable|TouchableOpacity/.test(PORTADA), 'queda un pulsable sin el movimiento común.');
    assert.ok(!/import \{[^}]*\bPressable\b[^}]*\} from 'react-native'/.test(PORTADA));
  });
});

describe('Eventos y Servicios, con el mismo dibujo', () => {
  const EVENTOS = sinComentarios(fuente('screens/EventsScreen.tsx'));
  const SERVICIO = sinComentarios(fuente('components/TarjetaDeServicio.tsx'));

  it('los filtros de Eventos son la misma píldora que los de Cursos', () => {
    assert.match(EVENTOS, /<Chip\s+key=\{opcion\.clave\}[\s\S]*?selected=\{elegida\}[\s\S]*?rol="radio"/);
    assert.ok(!/styles\.modalidad\b/.test(EVENTOS), 'vuelve a haber una píldora dibujada a mano.');
  });

  it('la fila de un evento no crece sin tope', () => {
    const desde = EVENTOS.indexOf('style={styles.cuerpoDeFila}');
    const cuerpo = EVENTOS.slice(desde, EVENTOS.indexOf('</Pulsable>', desde));
    assert.ok(desde !== -1 && cuerpo.length > 0, 'no se encuentra el cuerpo de la fila.');
    assert.match(cuerpo, /<Text numberOfLines=\{2\} style=\{\[styles\.title/);
    assert.match(cuerpo, /<Text numberOfLines=\{2\} style=\{\[styles\.description/);
    assert.match(cuerpo, /<Text numberOfLines=\{1\} style=\{\[styles\.meta/);
    // Y se sigue leyendo: nada por debajo de 11.
    for (const estilo of ['title', 'description', 'meta']) {
      const tamano = Number(new RegExp(`\\n {2}${estilo}: \\{ fontSize: (\\d+)`).exec(EVENTOS)?.[1]);
      assert.ok(tamano >= 11, `${estilo} mide ${tamano}`);
    }
  });

  it('lo que hace cada toque en Eventos no ha cambiado', () => {
    // Solo cambia cómo responde al dedo: a dónde lleva y qué reserva, igual.
    assert.match(EVENTOS, /onPress=\{\(\) => router\.push\(`\/eventos\/\$\{event\.id\}` as never\)\}/);
    assert.match(
      EVENTOS,
      /onPress=\{\(\) =>\s*event\.type === 'live'\s*\? router\.push\(`\/eventos\/\$\{event\.id\}` as never\)\s*: toggle\(event\.id\)\s*\}/,
    );
    assert.match(EVENTOS, /onPress=\{\(\) => setModalidad\(opcion\.valor\)\}/);
  });

  it('un servicio sin foto enseña el mismo hueco, y se le sigue diciendo al lector de pantalla', () => {
    assert.match(
      SERVICIO,
      /<PortadaVacia\s+icono="briefcase"\s+style=\{styles\.portada\}\s+etiqueta=\{tarjeta\.cover\?\.alt_text \?\? f\('servicios\.descubrir\.sinImagen'\)\}/,
    );
    assert.match(SERVICIO, /<Pulsable\s+onPress=\{alAbrir\}/);
  });
});

describe('los accesos a las verticales', () => {
  it('las que no existen lo dicen, en vez de llevar a ninguna parte', () => {
    // Servicios existe desde el Incremento 3, pero SOLO con `FEATURE_SERVICES`
    // encendida: apagada, el acceso sigue avisando de que aún no está.
    assert.ok(ACCESOS.includes("{ clave: 'servicios', icono: 'briefcase', ruta: '/servicios', conBandera: true }"));
    assert.ok(ACCESOS.includes('(!vertical.conBandera || serviciosEncendido)'));
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
