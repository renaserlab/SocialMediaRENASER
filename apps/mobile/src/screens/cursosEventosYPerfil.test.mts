/**
 * Lo que no puede volver a la ficha de un curso, a la agenda ni al perfil.
 *
 * Estas comprobaciones miran el CÓDIGO FUENTE, no la pantalla, por lo mismo que
 * explican `components/cuadriculaSinReproductores.test.mts` y
 * `screens/perfilResenasBloqueoYChat.test.mts`: montar la vista pediría un
 * renderizador de React Native que este proyecto no tiene en las pruebas, y lo
 * que hay que impedir no es un valor mal calculado sino que vuelva a colarse
 * una construcción que ya causó el problema una vez.
 *
 * Las reglas de verdad —si una fecha ya pasó, si un curso está anunciado sin
 * contenido— viven en el BACKEND y tienen sus propias pruebas
 * (`apps/api/tests/test_eventos_por_fecha.py`). Aquí solo se fija lo que la
 * interfaz enseña con esas respuestas.
 *
 * LOS SEIS FALLOS QUE FIJA, todos vistos en la aplicación:
 *
 *  1. Un curso decía «2 módulos · 1 lecciones · Próximamente» y ofrecía
 *     «Empezar curso» y el globo «Toca aquí: abre la primera lección del
 *     temario», encima del recuadro que decía que no había contenido.
 *  2. `coming_soon` se leía de DOS sitios a la vez —la API y Supabase—, así que
 *     la etiqueta de arriba y el bloque de abajo podían decir cosas distintas.
 *  3. El interruptor de «Próximamente» se rotulaba con `live.hide`
 *     («Ocultar»), una cadena del módulo de emisiones en vivo.
 *  4. Los eventos ya celebrados se mezclaban con los vigentes bajo el título
 *     «Próximos eventos».
 *  5. «Lo que puede aportar» se pintaba entera y ocupaba media pantalla.
 *  6. El acceso a Reseñas llevaba una estrella, que significa puntuación.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

/**
 * El fichero SIN comentarios.
 *
 * Los comentarios de este proyecto explican los fallos que se arreglaron y
 * varios CITAN literalmente lo que ya no puede aparecer —`live.hide`, la
 * estrella, el orden viejo—. Sin quitarlos, estas pruebas fallarían por la
 * explicación del arreglo, y la única forma de aprobarlas sería borrar el
 * porqué: justo lo que no interesa perder.
 */
function sinComentarios(codigo: string): string {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

const CURSO = fuente('screens/CourseScreen.tsx');
const EDITOR = fuente('components/CourseContentEditor.tsx');
const REPO_CONTENIDO = fuente('repositories/CourseContentRepository.ts');
const EVENTOS = fuente('screens/EventsScreen.tsx');
const EXPLORAR = fuente('screens/ExploreScreen.tsx');
const MAPEADOR = fuente('mappers/catalogMapper.ts');
const PERFIL = fuente('screens/ProfileScreen.tsx');
const OFERTA = fuente('components/OfertaDelPerfil.tsx');

/** Dónde aparece un trozo de código, para poder comparar ORDEN. */
function posicion(codigo: string, aguja: string | RegExp): number {
  const indice =
    typeof aguja === 'string' ? codigo.indexOf(aguja) : codigo.search(aguja);
  assert.ok(indice >= 0, `no se encuentra «${aguja}» en la pantalla`);
  return indice;
}

// ---------------------------------------------------------------------------
// 1. «Próximamente» significa algo
// ---------------------------------------------------------------------------
describe('un curso anunciado sin contenido', () => {
  it('no ofrece abrir contenido a quien no lo gestiona', () => {
    assert.match(
      CURSO,
      /const contenidoNoDisponible = !!course\?\.comingSoon && !canManage;/,
      'La ficha del curso tiene que derivar el estado de `comingSoon` Y de si ' +
        'quien mira gestiona el curso: su autor sigue viendo el temario, que ' +
        'es justo lo que está preparando.',
    );
  });

  it('no enseña el globo «abre la primera lección»', () => {
    const globo = CURSO.slice(
      posicion(CURSO, "id=\"curso-temario\""),
      posicion(CURSO, "text={t('course.firstLessonHint')}"),
    );
    assert.match(
      globo,
      /!contenidoNoDisponible/,
      'El globo que invita a abrir la primera lección no puede salir encima ' +
        'de un recuadro que dice que el contenido no está preparado.',
    );
  });

  it('no ofrece «Empezar curso»', () => {
    assert.match(
      sinComentarios(CURSO),
      /\) : contenidoNoDisponible \? null : \(\s*<Button/,
      'La llamada a la acción que ABRE contenido tiene que desaparecer: no ' +
        'basta con desactivarla, porque no hay nada que empezar todavía.',
    );
  });

  it('no anuncia módulos ni lecciones que no se pueden abrir', () => {
    const info = CURSO.slice(
      posicion(CURSO, 'style={[styles.info,'),
      posicion(CURSO, '<CourseHighlights'),
    );
    assert.match(
      sinComentarios(info),
      /contenidoNoDisponible \? null : \(/,
      '«2 módulos · 1 lecciones» al lado de «Próximamente» es la ' +
        'contradicción de la captura en una sola línea.',
    );
  });

  it('el aviso NO se muestra siempre: depende del estado real', () => {
    assert.match(
      EDITOR,
      /if \(comingSoon && !canEdit\) \{/,
      'El recuadro «Próximamente» sigue estando condicionado. Si alguien lo ' +
        'dejara fijo, TODOS los cursos dirían que no tienen contenido.',
    );
    assert.ok(
      /t\('syllabus\.soonBody'\)/.test(EDITOR),
      'El texto del aviso se lee del diccionario, no escrito a mano.',
    );
  });

  it('un curso normal no lo muestra por ninguna vía', () => {
    /*
      Las DOS puertas por las que «Próximamente» puede aparecer, y las dos
      cuelgan del estado real. Se comprueba línea a línea en vez de con una
      expresión suelta: lo que hay que garantizar es que no exista NINGUNA
      aparición incondicional, no que exista una condicionada.
    */
    const enLaFicha = sinComentarios(CURSO)
      .split('\n')
      .filter((linea) => linea.includes('common.comingSoon'));
    assert.equal(
      enLaFicha.length,
      1,
      'Solo puede haber un sitio en la ficha que escriba «Próximamente».',
    );
    assert.match(
      enLaFicha[0]!,
      /course\.comingSoon \?/,
      'Y tiene que colgar del estado del curso, no pintarse siempre.',
    );

    // En el temario, el aviso vive dentro del retorno temprano y en ningún
    // otro sitio: fuera de él se pinta el temario normal.
    const editor = sinComentarios(EDITOR);
    const guarda = posicion(editor, 'if (comingSoon && !canEdit) {');
    const avisos = [...editor.matchAll(/t\('syllabus\.soonBody'\)/g)];
    assert.equal(avisos.length, 1, 'un solo aviso, no uno por rama');
    assert.ok(
      avisos[0]!.index! > guarda,
      'El aviso tiene que estar DENTRO de la condición que lo justifica.',
    );
  });
});

describe('el estado del contenido de un curso', () => {
  it('se lee de un solo sitio', () => {
    assert.doesNotMatch(
      REPO_CONTENIDO,
      /async getComingSoon\(/,
      'Había un lector contra Supabase mientras la ficha usaba el de la API: ' +
        'dos fuentes para el mismo dato son dos respuestas posibles.',
    );
    assert.match(
      REPO_CONTENIDO,
      /async setComingSoon\(/,
      'Escribir sí sigue aquí: el contenido del curso se escribe contra ' +
        'Supabase directamente.',
    );
    assert.match(
      EDITOR,
      /comingSoon: boolean;/,
      'El editor recibe el estado de la pantalla, no lo vuelve a pedir.',
    );
    assert.match(
      CURSO,
      /comingSoon=\{!!course\.comingSoon\}/,
      'Y la pantalla se lo pasa desde el detalle del curso.',
    );
  });

  it('al cambiarlo se avisa a la pantalla', () => {
    const cambio = EDITOR.slice(
      posicion(EDITOR, 'const toggleComingSoon'),
      posicion(EDITOR, 'const addModule'),
    );
    assert.match(
      cambio,
      /onChanged\?\.\(\)/,
      'Sin este aviso, tocar el interruptor cambiaba el bloque de abajo y ' +
        'dejaba la etiqueta de arriba diciendo lo contrario.',
    );
  });

  it('el interruptor no se rotula con una cadena de otro módulo', () => {
    const codigo = sinComentarios(EDITOR);
    assert.doesNotMatch(
      codigo,
      /t\('live\.hide'\)/,
      '«Ocultar» venía de las emisiones en vivo («¿Ocultar este mensaje?»). ' +
        'Un toque sobre eso dejaba el temario invisible para todos los alumnos.',
    );
    assert.match(codigo, /t\('syllabus\.markSoon'\)/);
    assert.match(codigo, /t\('syllabus\.publishContent'\)/);
    assert.match(
      codigo,
      /accessibilityRole="switch"[\s\S]{0,120}accessibilityState=\{\{ checked: comingSoon \}\}/,
      'Es un conmutador y tiene que anunciarse como tal.',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Los eventos vencidos no se anuncian como próximos
// ---------------------------------------------------------------------------
describe('la agenda de eventos', () => {
  it('agrupa por lo que dijo el servidor, no por el texto de la fecha', () => {
    const codigo = sinComentarios(EVENTOS);
    assert.match(codigo, /evento\.timeState === 'past'/);
    assert.match(codigo, /evento\.timeState === 'undated'/);
    assert.doesNotMatch(
      codigo,
      /event\.date\s*[<>=]|new Date\(/,
      '`date` es el texto ya formateado: cambia con el idioma, no siempre ' +
        'lleva año y no sabe nada de la fecha de fin. Comparar eso es el ' +
        'fallo, no el arreglo.',
    );
  });

  it('separa los tres grupos con su propio título', () => {
    const codigo = sinComentarios(EVENTOS);
    for (const clave of ['events.upcoming', 'events.undated', 'events.past']) {
      assert.ok(
        codigo.includes(`t('${clave}')`),
        `falta el título del grupo «${clave}»`,
      );
    }
    // Y el encabezado de la pantalla ya no promete solo los próximos.
    assert.match(codigo, /title=\{t\('events\.title'\)\}/);
  });

  it('no ofrece reservar algo que ya terminó', () => {
    const codigo = sinComentarios(EVENTOS);
    assert.match(
      codigo,
      /finalizado \? \(/,
      'Un evento terminado no se reserva: se dice que está finalizado en vez ' +
        'de dejar un botón que no lleva a ninguna parte.',
    );
    assert.match(codigo, /t\('event\.finished'\)/);
  });

  it('el histórico sigue siendo consultable', () => {
    assert.match(
      sinComentarios(EVENTOS),
      /grupos\.anteriores\.map/,
      'Los eventos pasados se sacan de donde estorbaban, no se esconden.',
    );
  });

  it('Explorar pide al servidor solo los vigentes', () => {
    assert.match(
      sinComentarios(EXPLORAR),
      // El grupo lo decide el SERVIDOR. El segundo argumento —cuántos— es
      // otra cosa y puede estar o no: lo añadió el recorte de peticiones.
      /CatalogRepository\.listEvents\('upcoming'(,[^)]*)?\)/,
      'Recortar aquí lo ya descargado dejaría la sección vacía en cuanto ' +
        'hubiera veinte eventos pasados y uno futuro.',
    );
  });

  it('el mapeador no se inventa la clasificación', () => {
    const codigo = sinComentarios(MAPEADOR);
    assert.match(
      codigo,
      /valor === 'upcoming' \|\| valor === 'past' \|\| valor === 'undated'/,
      'Solo se aceptan los tres valores conocidos.',
    );
    assert.match(
      codigo,
      /return 'undated';/,
      'Sin respuesta del servidor se responde «sin fecha», que es lo único ' +
        'cierto: es el valor que NO afirma ni futuro ni pasado.',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. El orden del perfil
// ---------------------------------------------------------------------------
describe('el perfil', () => {
  it('respeta el orden nuevo, de la foto al contenido', () => {
    // Solo la parte que se pinta de verdad: el esqueleto de carga repite
    // algunos de estos nombres más abajo y no dice nada del orden real.
    const vista = PERFIL.slice(0, posicion(PERFIL, 'function EsqueletoDePerfil'));
    const orden = [
      ['foto', 'styles.identidad'],
      ['nombre', 'styles.name, styles.centrado'],
      ['usuario', 'styles.username, styles.centrado'],
      ['cifras', 'styles.metricas'],
      ['descripción', 'styles.bio,'],
      ['audio', '<AudioDePresentacion'],
      ['lo que aporta', '<OfertaDelPerfil'],
      ['accesos', 'styles.shortcuts'],
    ] as const;

    let anterior = -1;
    for (const [nombre, aguja] of orden) {
      const donde = posicion(vista, aguja);
      assert.ok(
        donde > anterior,
        `«${nombre}» tiene que ir después de lo anterior en el nuevo orden.`,
      );
      anterior = donde;
    }
  });

  it('la descripción va centrada y con el ancho limitado', () => {
    const codigo = sinComentarios(PERFIL);
    assert.match(codigo, /textAlign: bioLarga \? 'left' : 'center'/);
    assert.match(
      codigo,
      /maxWidth: 420,\s*alignSelf: 'center',/,
      'Un texto centrado de borde a borde obliga a buscar dónde empieza cada ' +
        'línea.',
    );
    assert.match(
      codigo,
      /onTextLayout=/,
      'Cuántas líneas ocupa se MIDE; contar caracteres es adivinar, porque la ' +
        'misma frase ocupa distinto en cada pantalla.',
    );
  });

  it('ya no afirma en ninguna parte que el audio vaya antes de la descripción', () => {
    /*
      La frase vieja —«el audio va ANTES de la descripcion, como pedia el
      documento»— puede seguir CITADA, porque explicar qué cambió es justo lo
      que hace útil un comentario. Lo que no puede es seguir siendo la
      descripción de lo que hace el código.

      Así que se comprueban las dos mitades: sin comentarios no queda ni rastro
      de esa afirmación, y donde se cita queda dicho que el requisito cambió.
    */
    assert.doesNotMatch(
      sinComentarios(PERFIL),
      /audio va ANTES de la descripci[oó]n/,
      'La afirmación vieja no puede quedar como si describiera el código.',
    );
    if (/audio va ANTES de la descripci[oó]n/.test(PERFIL)) {
      assert.match(
        PERFIL,
        /ESTE ORDEN SUSTITUYE AL ANTERIOR/,
        'Si se cita el requisito viejo hay que decir, ahí mismo, que ya no ' +
          'rige: un comentario a medias es peor que ninguno.',
      );
    }
  });

  it('el acceso a Reseñas lleva comillas, no una estrella', () => {
    const codigo = sinComentarios(PERFIL);
    assert.match(
      codigo,
      /icono=\{\{ familia: 'material', nombre: 'format-quote-close' \}\}[\s\S]{0,120}t\('profile\.testimonials'\)/,
      'Una estrella significa puntuación o favorito; lo que hay en esa ' +
        'sección son opiniones escritas, y eso se dice con comillas.',
    );
    assert.doesNotMatch(
      codigo,
      /icon="star"/,
      'La estrella no puede volver por la puerta de atrás.',
    );
    // Y sin instalar nada: la familia sale del paquete que ya estaba.
    assert.match(
      PERFIL,
      /import \{ Feather, MaterialCommunityIcons \} from '@expo\/vector-icons';/,
    );
    // Los otros tres accesos siguen en Feather: el cambio es de UN icono.
    for (const nombre of ['headphones', 'book', 'calendar']) {
      assert.ok(
        codigo.includes(`icono={{ familia: 'feather', nombre: '${nombre}' }}`),
        `el acceso «${nombre}» tiene que seguir siendo de Feather`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 4. «Lo que puede aportar», plegada
// ---------------------------------------------------------------------------
describe('«Lo que puede aportar»', () => {
  it('empieza plegada', () => {
    assert.match(
      OFERTA,
      /const \[abierta, setAbierta\] = useState\(false\);/,
      'Cerrada al llegar: es el estado en el que la sección estorba menos y ' +
        'sigue diciendo que existe.',
    );
  });

  it('el encabezado entero es lo que se pulsa, y lo anuncia', () => {
    const codigo = sinComentarios(OFERTA);
    // `Pulsable` es el `Pressable` de la aplicación: toda la fila responde.
    assert.match(codigo, /<Pulsable/);
    assert.match(
      codigo,
      /accessibilityState=\{\{ expanded: abierta \}\}/,
      'Sin `expanded`, un lector de pantalla lee un título y deja a quien ' +
        'escucha sin saber que hay algo debajo.',
    );
    // La flecha GIRA media vuelta: en reposo se ve abajo (cerrada) o arriba
    // (abierta), que es un cambio de FORMA y no de color.
    assert.match(
      codigo,
      /<FlechaDeDesplegable abierto=\{abierta\} color=\{colors\.text\} \/>/,
      'La flecha cambia de FORMA, no solo de color: el sistema es blanco y ' +
        'negro.',
    );
    const flecha = sinComentarios(
      readFileSync(join(SRC, 'components', 'Desplegable.tsx'), 'utf8').replace(/\r\n/g, '\n'),
    );
    assert.match(flecha, /rotate: `\$\{giro\.value \* 180\}deg`/);
  });

  it('al expandir enseña la oferta, y solo entonces', () => {
    const codigo = sinComentarios(OFERTA);
    // La lista vive dentro del desplegable: cerrada mide cero, no se puede
    // tocar y el lector de pantalla no la recorre.
    assert.match(
      codigo,
      /<Desplegable abierto=\{abierta\}>\s*<View style=\{styles\.lista\}>/,
      'La lista de temas se enseña únicamente con la sección abierta.',
    );
    const desplegable = sinComentarios(
      readFileSync(join(SRC, 'components', 'Desplegable.tsx'), 'utf8').replace(/\r\n/g, '\n'),
    );
    assert.match(desplegable, /pointerEvents=\{abierto \? 'auto' : 'none'\}/);
    assert.match(desplegable, /accessibilityElementsHidden=\{!abierto\}/);
    assert.match(desplegable, /height: avance\.value \* alto/, 'anima la altura');
    assert.match(desplegable, /opacity: avance\.value/, 'y la opacidad');
    assert.match(desplegable, /useReducedMotion\(\)/);
    assert.match(
      codigo,
      /visibles\.map\(\(tema\)/,
      'Y lo que enseña son los temas que de verdad tienen alguna relación ' +
        'que sepamos escribir.',
    );
  });

  it('sigue sin enseñar la demanda privada', () => {
    const codigo = sinComentarios(OFERTA);
    assert.match(codigo, /getProfileOffer\(perfilId\)/);
    assert.doesNotMatch(
      codigo,
      /getPreferences|learning_topic_ids|learningTopicIds/,
      'Lo que alguien BUSCA es privado —puede ser una enfermedad, una deuda—: ' +
        'plegar la sección no puede haber abierto esa puerta.',
    );
  });

  it('funciona igual en el perfil propio y en el ajeno', () => {
    const codigo = sinComentarios(OFERTA);
    assert.match(
      codigo,
      /const titulo = esPropio \? t\('offer\.titleOwn'\) : t\('offer\.titleOther'\);/,
      'El encabezado cambia de voz, pero es el mismo control plegable en los ' +
        'dos casos.',
    );
    assert.match(PERFIL, /<OfertaDelPerfil perfilId=\{galleryOwnerId\} esPropio=\{!isPublic\} \/>/);
  });
});
