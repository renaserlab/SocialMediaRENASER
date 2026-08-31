/**
 * Lo que NUNCA puede volver al perfil, a las reseñas, al bloqueo ni al chat.
 *
 * Estas comprobaciones miran el CODIGO FUENTE, no la pantalla, por lo mismo que
 * explica `components/cuadriculaSinReproductores.test.mts`: montar la vista
 * pediria un renderizador de React Native que este proyecto no tiene en las
 * pruebas, y lo que hay que impedir no es un valor mal calculado sino que
 * vuelva a colarse una construccion que ya causo el problema una vez.
 *
 * Las reglas de verdad —quien puede escribir una reseña, quien borra un
 * mensaje, si una fecha ya paso— viven en el BACKEND y tienen sus propias
 * pruebas en `apps/api/tests`. Aqui solo se fija lo que la interfaz enseña.
 *
 * LOS SEIS FALLOS QUE FIJA, todos vistos en la aplicacion:
 *
 *  1. No se distinguia que seccion del perfil estaba abierta.
 *  2. En el perfil de OTRA persona se leia «Aún no tienes reseñas» —segunda
 *     persona— y un boton «Ver reseñas de Z» que llevaba al perfil de Darren.
 *     Las reseñas de esa persona no se pedian NUNCA.
 *  3. La galeria de fotos («Su galería» / «Añadir a la galería» / Todos, Fotos,
 *     Vídeos) vivia empotrada dentro de la seccion de Reseñas.
 *  4. `canManage` se usaba como si fuera «es su perfil», y tambien es cierto
 *     para la moderacion.
 *  5. Bloquear desde el menu «Opciones» lanzaba el dialogo encima de una hoja
 *     abierta: en iOS no se ve y `confirm()` no resuelve nunca.
 *  6. Un mensaje borrado desaparecia sin dejar hueco.
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
 * Hace falta para las comprobaciones que buscan un texto prohibido. Los
 * comentarios de este proyecto explican los fallos que se arreglaron, y varios
 * CITAN literalmente lo que ya no puede aparecer en pantalla («Aún no tienes
 * reseñas», el nombre propio que se quito). Sin quitarlos, la prueba fallaria
 * por la explicacion del arreglo — y la unica forma de que pasara seria borrar
 * el porque, que es justo lo que no interesa perder.
 */
function sinComentarios(codigo: string): string {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

const PERFIL = fuente('screens/ProfileScreen.tsx');
const SECCION = fuente('components/ProfileSection.tsx');
const HOJA_DE_RESENA = fuente('components/CreateReviewSheet.tsx');
const CHAT = fuente('screens/ChatScreen.tsx');
const REPO_RESENAS = fuente('repositories/ReviewRepository.ts');
const REPO_MENSAJES = fuente('repositories/MessageRepository.ts');

/** El trozo de `ProfileSection` que pinta las reseñas recibidas. */
function ramaDeResenas(): string {
  const desde = SECCION.indexOf("if (kind === 'testimonios') {");
  assert.ok(desde > 0, 'No se encuentra la rama de reseñas de ProfileSection.');
  const hasta = SECCION.indexOf('const items = kind ===', desde);
  return SECCION.slice(desde, hasta > 0 ? hasta : undefined);
}

// ---------------------------------------------------------------------------
// 1. Se ve que seccion esta abierta
// ---------------------------------------------------------------------------
describe('los accesos circulares del perfil', () => {
  it('dicen cual esta activo', () => {
    assert.ok(
      /active=\{activeSection === 'podcast'\}/.test(PERFIL) &&
        /active=\{activeSection === 'cursos'\}/.test(PERFIL) &&
        /active=\{activeSection === 'testimonios'\}/.test(PERFIL),
      'Cada acceso tiene que recibir si es el activo: sin eso, tocar uno ' +
        'cambia el contenido de abajo y arriba no cambia nada.',
    );
  });

  it('no lo dicen SOLO con color', () => {
    /*
      La regla del sistema visual: el color nunca puede ser el unico portador
      de informacion. Y aqui ademas es blanco y negro estricto, asi que «lo
      activo» tiene que leerse igual en escala de grises.
    */
    assert.ok(
      /fontWeight: active \? '800' : '500'/.test(PERFIL),
      'La etiqueta del acceso activo tiene que cambiar de peso.',
    );
    assert.ok(
      /accessibilityState=\{\{ selected: active \}\}/.test(PERFIL),
      'Y anunciarse a los lectores de pantalla.',
    );
  });

  it('usan tokens del tema y no colores fijos', () => {
    const shortcut = PERFIL.slice(PERFIL.indexOf('function Shortcut('));
    assert.ok(
      !/#[0-9A-Fa-f]{3,8}\b/.test(shortcut.slice(0, 2000)),
      'Hay un color escrito a mano en el acceso: rompe claro/oscuro.',
    );
    assert.ok(
      shortcut.includes('colors.primary') && shortcut.includes('colors.onPrimary'),
      'El activo se pinta con los tokens `primary` / `onPrimary`.',
    );
  });

  it('usan el icono de reseñas de Feather, sin dependencias nuevas', () => {
    assert.ok(
      /icon="star"[\s\S]{0,120}profile\.testimonials/.test(PERFIL),
      'Las reseñas van con `star`. La camara decia «fotos», que es lo que ' +
        'hacia la galeria que vivia dentro de esta seccion.',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. El perfil ajeno no habla en segunda persona ni remite a Darren
// ---------------------------------------------------------------------------
describe('las reseñas de un perfil ajeno', () => {
  it('no dicen «Aún no tienes reseñas»', () => {
    assert.ok(
      !sinComentarios(SECCION).includes('Aún no tienes reseñas'),
      'Ese texto va dirigido al dueño del perfil y se leia en el de otro.',
    );
  });

  it('hablan en tercera persona cuando no es tu perfil', () => {
    assert.ok(
      ramaDeResenas().includes('Este usuario aún no tiene reseñas publicadas'),
      'Falta el texto en tercera persona para el perfil ajeno.',
    );
  });

  it('no tratan a Darren como un caso especial', () => {
    // Sin comentarios: los de este fichero CITAN el texto que se quito para
    // explicar el fallo, y esa explicacion es lo que hay que conservar.
    const codigo = sinComentarios(SECCION);
    assert.ok(
      !/Darren/i.test(codigo),
      'Queda un nombre propio escrito en el codigo del perfil: quien ' +
        'administra la aplicacion se resuelve en tiempo de ejecucion.',
    );
    assert.ok(
      !codigo.includes('Ver reseñas de Z'),
      'Sigue el boton que llevaba las reseñas de alguien al perfil de otro.',
    );
  });

  it('ni siquiera tienen una entrada de «seccion de la administracion»', () => {
    /*
      LA CAUSA REAL DEL FALLO. `ADMIN_SECTIONS` se consulta ANTES de pintar
      nada, asi que con una entrada `testimonios` la seccion de reseñas de
      cualquier perfil que no administrara la aplicacion no llegaba a
      renderizarse: se cortaba arriba y se enseñaba el aviso.
    */
    const tabla = SECCION.slice(
      SECCION.indexOf('const ADMIN_SECTIONS'),
      SECCION.indexOf('const TESTIMONIAL_FILTERS'),
    );
    assert.ok(
      !/^\s*testimonios:/m.test(tabla),
      'ADMIN_SECTIONS vuelve a tener `testimonios`: eso impide que la seccion ' +
        'de reseñas se pinte en un perfil normal.',
    );
  });

  it('se piden SIEMPRE sobre el dueño del perfil', () => {
    assert.ok(
      SECCION.includes('ReviewRepository.listarRecibidas(profileOwnerId)'),
      'El listado tiene que ir con `profileOwnerId`, no con quien mira.',
    );
    assert.ok(
      !/listarRecibidas\((miId|currentUser)/.test(SECCION),
      'Se estan pidiendo las reseñas de quien mira, no las del perfil.',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Administrar no es ser el dueño
// ---------------------------------------------------------------------------
describe('`isOwnProfile` y `canManage` son cosas distintas', () => {
  it('el perfil pasa la identidad, no el permiso', () => {
    assert.ok(
      /isOwnProfile=\{!isPublic\}/.test(PERFIL),
      'ProfileScreen tiene que decir si el perfil es de quien mira.',
    );
    assert.ok(
      /profileOwnerId=\{galleryOwnerId\}/.test(PERFIL),
      'Y quien es el dueño, con ese nombre: `profileId` no decia de quien.',
    );
  });

  it('el texto vacio de reseñas depende de la IDENTIDAD', () => {
    const rama = ramaDeResenas();
    assert.ok(
      /\{isOwnProfile\s*\n?\s*\? 'Todavía no te ha escrito nadie\.'/.test(rama),
      'El texto en primera persona tiene que colgar de `isOwnProfile`. Con ' +
        '`canManage`, un moderador lo leeria en el perfil de cualquiera.',
    );
  });

  it('escribir una reseña se ofrece solo en el perfil ajeno', () => {
    assert.ok(
      ramaDeResenas().includes('{!isOwnProfile && resenasDisponibles ?'),
      'Nadie se reseña a si mismo: el boton no puede salir en tu perfil.',
    );
  });

  it('añadir a la galeria tambien es de la IDENTIDAD, no del permiso', () => {
    /*
      `CreateTestimonialSheet` publica SIEMPRE a nombre de quien escribe, asi
      que con `canManage` un moderador veia el boton en el perfil de otra
      persona y la foto acababa en SU galeria — donde esta lista, filtrada por
      el dueño del perfil, no la enseña. El boton prometia algo imposible.
    */
    const galeria = SECCION.slice(
      SECCION.indexOf("if (kind === 'galeria') {"),
      SECCION.indexOf("if (kind === 'testimonios') {"),
    );
    assert.ok(
      /\{isOwnProfile \? \(\s*\n\s*<Button\s*\n\s*label="Añadir a la galería"/.test(galeria),
      'Añadir a la galeria tiene que colgar de `isOwnProfile`.',
    );
  });
});

// ---------------------------------------------------------------------------
// 3.b Nadie se agenda una sesion consigo mismo
// ---------------------------------------------------------------------------
describe('pedir una sesion', () => {
  it('no se ofrece en el propio perfil', () => {
    assert.ok(
      /visible=\{bookingVisible && isPublic\}/.test(PERFIL),
      'La hoja se monta siempre y su destinatario cae en la persona conectada ' +
        'cuando el perfil es el propio: hace falta la condicion aqui tambien.',
    );
    assert.ok(
      /isPublic \? setBookingVisible\(true\) : router\.push\('\/agenda' as never\)/.test(PERFIL),
      'En el perfil propio, «Agenda» abre TU agenda, no una solicitud.',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. La galeria, fuera de las reseñas
// ---------------------------------------------------------------------------
describe('la galeria de fotos', () => {
  it('ya no vive dentro de la seccion de reseñas', () => {
    const rama = ramaDeResenas();
    for (const resto of [
      'Su galería',
      'Añadir a la galería',
      'SegmentedControl',
      'CreateTestimonialSheet',
      'TESTIMONIAL_FILTERS',
    ]) {
      assert.ok(
        !rama.includes(resto),
        `«${resto}» sigue dentro de la seccion de Reseñas: son dos listas ` +
          'distintas —lo que le dijeron y lo que publico— bajo el mismo rotulo.',
      );
    }
  });

  it('tiene su propia seccion', () => {
    assert.ok(
      SECCION.includes("if (kind === 'galeria') {"),
      'La galeria es contenido real: se saca de Reseñas, no se borra.',
    );
    assert.ok(
      /'galeria'/.test(PERFIL),
      'Y tiene que haber por donde llegar a ella desde el perfil.',
    );
  });

  it('no se pide cuando se abren las reseñas', () => {
    assert.ok(
      /kind === 'galeria'\s*\n?\s*\? \/\*[\s\S]{0,900}?TestimonialRepository\.list\(/.test(
        SECCION,
      ),
      'La galeria solo se pide en su seccion: pedirla al abrir las reseñas es ' +
        'una peticion de mas en cada perfil que alguien mire.',
    );
  });
});

// ---------------------------------------------------------------------------
// 5. El curso opcional de una reseña (migracion 0041)
// ---------------------------------------------------------------------------
describe('de que curso habla una reseña', () => {
  it('solo se ofrece si el servidor lo admite', () => {
    assert.ok(
      HOJA_DE_RESENA.includes('cursosDisponibles && cursos.length > 0'),
      'Sin la 0041 aplicada —o sin cursos— el selector no se enseña: pedir un ' +
        'dato que se va a tirar sin decirlo es peor que no pedirlo.',
    );
  });

  it('solo ofrece cursos de la persona reseñada', () => {
    assert.ok(
      HOJA_DE_RESENA.includes('lista.filter((c) => c.authorId === sobreId)'),
      'El servidor lo vuelve a comprobar, pero ofrecer cursos ajenos es ' +
        'ofrecer algo que va a ser rechazado.',
    );
  });

  it('distingue «no lo toques» de «quitalo»', () => {
    assert.ok(
      REPO_RESENAS.includes("...('cursoId' in datos ? { course_id: datos.cursoId ?? null } : {})"),
      'Con `!== undefined` el `null` no llegaria a viajar y no habria forma ' +
        'de desenlazar un curso elegido por error.',
    );
  });

  it('no distingue lo elegido solo por el color', () => {
    const opcion = HOJA_DE_RESENA.slice(HOJA_DE_RESENA.indexOf('function OpcionDeCurso'));
    assert.ok(
      opcion.includes('accessibilityState={{ selected: seleccionada }}') &&
        opcion.includes('<Feather name="check"'),
      'La opcion marcada necesita icono y estado accesible, no solo relleno.',
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Bloquear y desbloquear
// ---------------------------------------------------------------------------
describe('bloquear', () => {
  it('pregunta antes, con Cancelar y Bloquear', () => {
    assert.ok(
      /confirmLabel: 'Bloquear',\s*\n\s*cancelLabel: 'Cancelar',/.test(PERFIL),
      'Bloquear deshace ademas el seguimiento en los dos sentidos: no puede ' +
        'dispararse por un roce con el dedo.',
    );
  });

  it('espera a que la hoja se cierre antes de preguntar', () => {
    /*
      LA TRAMPA DE iOS. Los `BottomSheet` son `Modal`, y no se presenta nada
      encima de un Modal que sigue en pantalla: el dialogo no aparece Y
      `confirm()` no resuelve NUNCA, asi que la pantalla se queda congelada
      esperando una respuesta que nadie puede dar.
    */
    assert.ok(
      PERFIL.includes('if (desdeLaHoja) await afterSheetClose();'),
      'Falta la espera: el bloqueo desde el menu «Opciones» congelaba la ' +
        'pantalla en iOS.',
    );
    assert.ok(
      PERFIL.includes('void toggleBlock(true);'),
      'Y la llamada desde la hoja tiene que decir que viene de una hoja.',
    );
    assert.ok(
      !/onPress=\{toggleBlock\}/.test(PERFIL),
      'Pasar la funcion directa le mete el EVENTO del toque como primer ' +
        'argumento, que siempre es cierto: esperaria sin haber ninguna hoja.',
    );
  });

  it('deja desbloquear desde el propio perfil', () => {
    assert.ok(
      PERFIL.includes("blocked ? 'Desbloquear a esta persona' : 'Bloquear a esta persona'"),
      'Deshacer algo tiene que estar donde se hizo.',
    );
  });

  it('reutiliza el bloqueo que ya existe', () => {
    assert.ok(
      PERFIL.includes('ProfileRepository.unblock(id)') &&
        PERFIL.includes('ProfileRepository.block(id)'),
      'No se crea otro camino de bloqueo: se usa el que ya hay.',
    );
  });

  it('esconde el contenido del perfil bloqueado, pero no el perfil', () => {
    assert.ok(
      PERFIL.includes('const perfilBloqueado = isPublic && blocked;'),
      'Falta el estado que decide que se esconde.',
    );
    assert.ok(
      /\{perfilBloqueado \? \(\s*\n\s*<View style=\{styles\.bloqueado\}>/.test(PERFIL),
      'Estando bloqueado hay que decir por que no hay nada, no dejar un hueco.',
    );
    assert.ok(
      /label="Desbloquear"/.test(PERFIL),
      'Y el boton de desbloquear tiene que seguir alcanzable: si el perfil ' +
        'dejara de serlo, no habria desde donde deshacerlo.',
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Borrar un mensaje
// ---------------------------------------------------------------------------
describe('eliminar un mensaje', () => {
  it('deja una lapida y no un hueco', () => {
    assert.ok(
      CHAT.includes('Mensaje eliminado'),
      'Si el mensaje desapareciera sin rastro, la conversacion mentiria: ' +
        'quien esta al otro lado leyo algo que ahora no esta.',
    );
    assert.ok(
      /if \(item\.eliminado\) \{/.test(CHAT),
      'La lapida se pinta distinta de una burbuja normal.',
    );
  });

  it('solo se ofrece sobre los mensajes propios', () => {
    assert.ok(
      /onLongPress=\{\s*\n?\s*mine && !item\.estado \? \(\) => void eliminarMensaje\(item\) : undefined\s*\n?\s*\}/.test(
        CHAT,
      ),
      'Nadie borra mensajes ajenos. El servidor lo vuelve a comprobar ' +
        '(`message_not_yours`); esto solo evita ofrecerlo.',
    );
  });

  it('pregunta antes, porque no se puede deshacer', () => {
    assert.ok(
      /title: 'Eliminar mensaje',/.test(CHAT) && /confirmLabel: 'Eliminar',/.test(CHAT),
      'Lo borrado desaparece tambien del telefono de la otra persona.',
    );
  });

  it('no anida un Pressable dentro de otro', () => {
    /*
      En web cada `Pressable` es un `<button>`, y los adjuntos YA son
      `Pressable` (se tocan para ver la foto). Uno rodeando a otro genera HTML
      invalido y rompe la hidratacion: es una trampa que este proyecto ya pago.
      Los adjuntos y la zona de pulsacion larga van como HERMANOS.
    */
    const burbuja = CHAT.slice(
      CHAT.indexOf('{item.attachments?.length ? ('),
      CHAT.indexOf('{fallido ? ('),
    );
    const abrePressable = burbuja.indexOf('<Pressable');
    const adjuntos = burbuja.indexOf('pintarAdjunto(adjunto, mine)');
    assert.ok(
      abrePressable > adjuntos,
      'La zona de pulsacion larga envuelve a los adjuntos: en web eso es un ' +
        '<button> dentro de otro.',
    );
  });

  it('usa el borrado suave del servidor', () => {
    assert.ok(
      REPO_MENSAJES.includes("{ method: 'DELETE' }") &&
        REPO_MENSAJES.includes('async deleteMessage('),
      'Falta la llamada al borrado.',
    );
  });
});
