import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Lo que NUNCA puede volver al chat, ni entrar en él por la puerta de atrás.
 *
 * Estas comprobaciones miran el CODIGO FUENTE y no la pantalla, por lo mismo
 * que `cuadriculaSinReproductores.test.mts` y `audioDelReproductor.test.mts`:
 * montar la vista pediría un renderizador de React Native que este proyecto no
 * tiene en las pruebas, y lo que hay que impedir no es un valor mal calculado
 * sino que alguien vuelva a introducir un patrón que ya costó caro una vez.
 *
 * Las cuatro cosas que fija:
 *
 *  1. UN SOLO REPRODUCTOR DE AUDIO EN TODA LA CONVERSACION. Un reproductor
 *     nativo por celda agotó la memoria de Android y cerró la aplicación —dos
 *     veces, en la cuadrícula del perfil y en las reseñas—. Un chat es peor que
 *     una cuadrícula: pagina, así que la lista crece sin techo.
 *  2. NADIE OFRECE GRABAR SIN SABER SI EL SERVIDOR PUEDE GUARDARLO. Sin la
 *     migración 0044 el backend responde 503; pintar el micrófono igual sería
 *     dejar que alguien hable treinta segundos para perderlo todo.
 *  3. LA RESPUESTA A UNA HISTORIA VIAJA COMO ESTRUCTURA, no como una URL
 *     metida dentro del texto.
 *  4. UN AUDIO NO SE MANDA COMO `document` PARA NO TOCAR EL `CHECK`.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

const CHAT = fuente('screens/ChatScreen.tsx');
const BURBUJA = fuente('components/BurbujaDeNotaDeVoz.tsx');
const GRABADORA = fuente('hooks/useGrabadoraDeVoz.ts');
const VISOR = fuente('screens/StoriesScreen.tsx');
const REPO = fuente('repositories/MessageRepository.ts');

// ---------------------------------------------------------------------------
// 1. Un solo reproductor de audio en toda la conversacion
// ---------------------------------------------------------------------------
describe('las notas de voz no montan un reproductor por burbuja', () => {
  it('la pantalla decide cuál suena, no la burbuja', () => {
    /*
      La guarda tiene que vivir FUERA del componente que reproduce: un
      componente no puede decidir no montarse a sí mismo. Es el mismo patrón que
      `videoAbierto ===` en `ProfileSection` y `active || preload` en
      `ShortVideoItem`.
    */
    assert.ok(
      /const \[audioSonando, setAudioSonando\] = useState<string \| null>\(null\)/.test(CHAT),
      'ChatScreen ya no lleva la cuenta de qué nota está sonando: sin eso, ' +
        'cada burbuja monta su propio reproductor.',
    );
    assert.ok(
      /activo=\{audioSonando === adjunto\.id\}/.test(CHAT),
      'La burbuja de audio tiene que recibir si es LA activa. Sin esa guarda, ' +
        'un historial de treinta notas son treinta reproductores nativos.',
    );
  });

  it('la burbuja solo toca expo-audio dentro del componente activo', () => {
    /*
      `useAudioPlayer` es un hook: si se llamara en el cuerpo de
      `BurbujaDeNotaDeVoz`, se ejecutaría en TODAS las burbujas del historial
      aunque ninguna estuviera sonando, y la guarda de arriba no serviría de
      nada. Tiene que vivir en un componente aparte que solo se monta cuando le
      toca.
    */
    const cuerpo = BURBUJA.slice(
      BURBUJA.indexOf('export function BurbujaDeNotaDeVoz'),
      BURBUJA.indexOf('function NotaSonando'),
    );
    assert.ok(
      !cuerpo.includes('useAudioPlayer'),
      'BurbujaDeNotaDeVoz crea un reproductor en su cuerpo: entonces lo crea ' +
        'para cada mensaje del historial, esté sonando o no.',
    );
    assert.ok(
      /if \(activo && adjunto\.url\) \{/.test(cuerpo),
      'Falta la condición que decide montar el reproductor o solo la carátula.',
    );
    assert.equal(
      (BURBUJA.match(/useAudioPlayer\(/g) ?? []).length,
      1,
      'Hay más de un sitio creando reproductor en el mismo fichero.',
    );
  });

  it('el reproductor se apaga en la fase de layout, no en la pasiva', () => {
    /*
      La lección de `audioDelReproductor.test.mts`, aplicada al chat: las
      limpiezas pasivas corren en orden de declaración y `expo-audio` suelta el
      objeto nativo en la SUYA, declarada dentro del hook. Un `pause()` en un
      `useEffect` normal caería sobre un objeto muerto y el audio seguiría
      oyéndose encima de la pantalla siguiente.
    */
    assert.ok(
      /useLayoutEffect\(\(\) => \{\s*return \(\) => \{[\s\S]{0,300}?\.pause\(\)/.test(BURBUJA),
      'Falta la limpieza de layout que pausa la nota al desmontarla.',
    );
    assert.ok(
      /muted = true/.test(BURBUJA),
      'Entre la pausa y la liberación nativa hay milisegundos en los que un ' +
        'buffer ya entregado sigue sonando: hay que silenciar además de pausar.',
    );
  });

  it('la duración se lee del servidor y no abriendo el fichero', () => {
    /*
      Preguntarle la duración al audio exigiría abrirlo, que es exactamente lo
      que toda esta pantalla evita. El backend la guarda al recibir la nota y por
      eso la exige.
    */
    assert.ok(
      /adjunto\.durationS \?\? 0/.test(BURBUJA),
      'La carátula tiene que pintarse con la duración que ya vino en el ' +
        'adjunto, sin montar nada.',
    );
  });

  it('nadie más toca la sesión de audio del proceso', () => {
    /*
      `setAudioModeAsync` cambia el audio de TODA la aplicación. Grabar necesita
      tocarlo en iOS, pero eso solo puede vivir donde se configura la sesión una
      vez —`hooks/useBackgroundAudio.ts`—, igual que ya exigía
      `audioDelReproductor.test.mts`.
    */
    const permitido = join(SRC, 'hooks', 'useBackgroundAudio.ts');
    const culpables: string[] = [];
    for (const ruta of ficherosDeCodigo(SRC)) {
      if (ruta === permitido || ruta.endsWith('.test.mts')) continue;
      if (readFileSync(ruta, 'utf8').includes('setAudioModeAsync')) {
        culpables.push(ruta.slice(SRC.length + 1));
      }
    }
    assert.deepEqual(culpables, []);
  });
});

function ficherosDeCodigo(dir: string, encontrados: string[] = []): string[] {
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const ruta = join(dir, entrada.name);
    if (entrada.isDirectory()) ficherosDeCodigo(ruta, encontrados);
    else if (/\.tsx?$/.test(entrada.name) && !entrada.name.endsWith('.d.ts')) {
      encontrados.push(ruta);
    }
  }
  return encontrados;
}

// ---------------------------------------------------------------------------
// 2. Nunca un boton muerto
// ---------------------------------------------------------------------------
describe('sin la migración 0044 no se ofrece grabar', () => {
  it('el micrófono depende de lo que diga el servidor', () => {
    assert.ok(
      /\{funciones\.notasDeVoz && !hayQueEnviar && supabaseEnabled \? \(/.test(CHAT),
      'El micrófono se pinta sin comprobar que el servidor puede guardar la ' +
        'nota. Sin la 0044 eso es un 503 después de grabar: el botón parece ' +
        'funcionar y quien habló treinta segundos lo pierde todo.',
    );
  });

  it('se pregunta una vez al abrir el chat', () => {
    assert.ok(
      /MessageRepository\.funciones\(\)/.test(CHAT),
      'Nadie pregunta qué funciones hay.',
    );
    assert.ok(
      /availability/.test(REPO),
      'El repositorio no consulta el endpoint de disponibilidad.',
    );
  });

  it('ante la duda, NO se ofrece', () => {
    /*
      Un fallo de red, o una API antigua que no conozca la ruta, responden
      `false`. Es preferible no ofrecer algo que quizá no funcione a ofrecerlo y
      perder lo que alguien acaba de grabar. Mismo criterio que
      `ReviewRepository.disponibles`.
    */
    const funciones = REPO.slice(REPO.indexOf('async funciones()'), REPO.indexOf('listConversations'));
    assert.ok(
      /notasDeVoz: dto\.voice_notes === true/.test(funciones),
      'Hay que exigir un `true` explícito, no dar por buena la ausencia del campo.',
    );
    assert.ok(
      /catch \{\s*\n\s*return SIN_FUNCIONES;/.test(funciones),
      'Un fallo de red tiene que responder que NO hay notas de voz.',
    );
    // Y «sin funciones» es de verdad ninguna: cada una nueva nace apagada.
    assert.ok(
      /export const SIN_FUNCIONES: FuncionesDelChat = \{\s*notasDeVoz: false,\s*respuestasAHistorias: false,\s*reacciones: false,\s*preferencias: false,\s*\};/.test(
        REPO,
      ),
      'Lo que se da por hecho sin respuesta del servidor tiene que ser «nada».',
    );
  });

  it('el 503 de las notas de voz se distingue del de los adjuntos', () => {
    /*
      No son lo mismo para quien mira: sin la 0033 no se puede mandar NADA
      adjunto; sin la 0044 se mandan fotos y solo faltan las notas de voz. Decir
      «no se pueden enviar archivos» cuando sí se pueden manda a buscar un
      problema que no existe.
    */
    assert.ok(CHAT.includes("codigo === 'voice_notes_not_available'"));
    assert.ok(CHAT.includes("t('chat.voiceNotesOffBody')"));
  });
});

// ---------------------------------------------------------------------------
// 3. El permiso de microfono se explica
// ---------------------------------------------------------------------------
describe('el permiso de micrófono', () => {
  it('reutiliza el módulo de permisos que ya existe y tiene pruebas', () => {
    /*
      `lib/permisos.ts` se apoya en `lib/estadoDePermiso.ts`, que distingue los
      cinco estados reales. Escribir otro sería volver a confundir «denegado»
      con «bloqueado», que es lo que deja un botón que no hace absolutamente
      nada porque el sistema ya no vuelve a preguntar.
    */
    assert.ok(
      /from '@\/lib\/permisos'/.test(GRABADORA),
      'La grabadora se ha escrito su propio manejo de permisos.',
    );
    assert.ok(/pedirPermiso\('microfono'\)/.test(GRABADORA));
  });

  it('un permiso denegado se explica en vez de fallar en silencio', () => {
    assert.ok(
      /textoDePermiso\('microfono', permiso\)/.test(GRABADORA),
      'Falta el texto que explica por qué no se puede grabar.',
    );
    assert.ok(
      /alAvisar\(\{/.test(GRABADORA),
      'La grabadora no avisa de nada cuando el permiso se deniega.',
    );
  });

  it('cuando el sistema ya no va a preguntar, se ofrece ir a los ajustes', () => {
    /*
      En iOS basta con haber dicho que no UNA vez. A partir de ahí, volver a
      pedirlo no hace nada y la única salida son los ajustes del teléfono: hay
      que llevar a la persona allí, no repetir la pregunta.
    */
    assert.ok(
      /vaAAjustes\s*\n?\s*\? \{ texto: texto\.accion, alPulsar: abrirAjustes \}/.test(GRABADORA),
      'Falta la salida a los ajustes cuando el permiso está bloqueado.',
    );
    assert.ok(
      /confirmLabel: aviso\.accion\.texto/.test(CHAT),
      'La pantalla tiene que ofrecer esa salida como un botón, no solo contarla.',
    );
  });

  it('sin permiso no se queda el micrófono abierto ni la sesión en modo grabación', () => {
    assert.ok(
      /await permitirGrabar\(false\)/.test(GRABADORA),
      'Hay que devolver la sesión de audio a reproducir: dejarla en modo ' +
        'grabación baja el volumen de todo lo demás en iOS.',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Responder una historia es ESTRUCTURA, no una URL en el texto
// ---------------------------------------------------------------------------
describe('responder a una historia', () => {
  it('manda el identificador aparte, nunca dentro del cuerpo', () => {
    /*
      El atajo prohibido: pegar la URL de la historia en el texto. Haría
      imposible distinguir una respuesta de verdad de alguien que pegó un
      enlace, obligaría a la bandeja a buscar cadenas dentro de los mensajes de
      todo el mundo para filtrar, y dejaría un enlace muerto en mitad de la
      frase en cuanto la historia caducara.
    */
    assert.ok(
      /story_id: storyId/.test(REPO),
      'El identificador de la historia tiene que viajar como campo propio.',
    );
    const enviar = VISOR.slice(VISOR.indexOf('const responder ='), VISOR.indexOf('// Swipe:'));
    assert.ok(
      /sendMessage\(\s*\n?\s*conversacion\.id,\s*\n?\s*texto,/.test(enviar),
      'El cuerpo del mensaje tiene que ser EXACTAMENTE lo que se escribió.',
    );
    assert.ok(
      !/texto \+|`\$\{texto\}|http/.test(enviar),
      'Se está componiendo el texto con algo más: el cuerpo es de quien escribe.',
    );
  });

  it('usa el camino idempotente que ya existe para abrir el chat', () => {
    /*
      `getOrCreateDirect` es idempotente en el servidor desde la 0039: la clave
      primaria de `direct_conversation_pairs` impide que dos peticiones a la vez
      creen dos chats con la misma persona. Inventar otro obtener-o-crear
      reabriría ese fallo por otro sitio.
    */
    assert.ok(
      /MessageRepository\.getOrCreateDirect\(group\.authorId\)/.test(VISOR),
      'El visor se inventa su propia forma de abrir la conversación.',
    );
  });

  it('cambiar de historia borra lo que se estaba escribiendo', () => {
    /*
      El visor avanza SOLO al acabarse el tiempo del tramo. Sin esto, empezar a
      responder a Ana, que pase a Bruno y pulsar enviar le manda a Bruno un
      texto pensado para Ana. Nadie tiene que tocar nada para que ocurra.
    */
    assert.ok(
      /useEffect\(\(\) => \{\s*\n\s*setRespuesta\(''\);\s*\n\s*\}, \[item\?\.id, group\?\.authorId\]\)/.test(
        VISOR,
      ),
      'Falta vaciar la respuesta al cambiar de tramo o de autor.',
    );
  });

  it('escribir pausa la historia', () => {
    assert.ok(
      /onFocus=\{\(\) => setPaused\(true\)\}/.test(VISOR),
      'Sin pausar, la historia avanza mientras se teclea y el mensaje acaba ' +
        'mandándose sobre otra distinta.',
    );
  });

  it('la burbuja sigue entendiéndose cuando la historia ya no existe', () => {
    /*
      El caso NORMAL, no el raro: una historia dura 24 horas y el mensaje dura
      para siempre, así que pasado un día TODAS las respuestas del historial
      están así. Tiene que decir qué pasó, y de quién era.
    */
    const cinta = fuente('components/RespuestaAHistoria.tsx');
    assert.ok(
      /t\('chat\.storyGone'\)/.test(cinta),
      'Falta el contexto degradado: sin él queda un hueco sin explicación.',
    );
    assert.ok(
      /contexto\.autor\.nombre/.test(cinta),
      'Se pierde de quién era la historia, que es lo único que sobrevive a su ' +
        'caducidad y lo que hace que el mensaje se siga entendiendo.',
    );
  });

  it('una lápida no enseña a qué respondía', () => {
    assert.ok(
      /storyContext: undefined/.test(CHAT),
      'Al borrar un mensaje hay que soltar también su contexto: decir «respondió ' +
        'a la historia de X» es parte de lo que su autor acaba de retirar.',
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Un audio es un audio, no un documento
// ---------------------------------------------------------------------------
describe('el tipo de adjunto de una nota de voz', () => {
  it('se manda como `audio`', () => {
    assert.ok(
      /kind: 'audio'/.test(GRABADORA),
      'La nota grabada tiene que salir con `kind: audio`. Mandarla como ' +
        '`document` para no tocar el CHECK de la tabla es el parche prohibido: ' +
        'la burbuja no sabría que eso se reproduce y la duración no ' +
        'significaría nada.',
    );
  });

  it('nadie manda un audio disfrazado de documento', () => {
    const media = fuente('services/messageMedia.ts');
    assert.ok(
      /'image' \| 'video' \| 'document' \| 'audio'/.test(media),
      'El tipo de adjunto no admite `audio`.',
    );
    assert.ok(
      /audio\/mp4/.test(media),
      'Un audio subido como `application/octet-stream` lo rechaza la lista de ' +
        'tipos permitidos del bucket `message-media`.',
    );
  });

  it('la nota lleva su duración desde el primer instante', () => {
    /*
      Sin esto, la burbuja de una nota recién grabada saldría marcando 0:00
      hasta que el servidor la devolviera.
    */
    assert.ok(
      /durationS: archivo\.durationS/.test(CHAT),
      'La burbuja optimista pierde la duración de la nota.',
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Regresion: lo que el chat ya hacia sigue en pie
// ---------------------------------------------------------------------------
describe('el motor del chat no se ha reescrito', () => {
  it('siguen la paginación, Realtime, la deduplicación y el reintento', () => {
    for (const pieza of [
      'instanteMasAntiguo', // paginación hacia atrás por instante
      'instanteMasReciente', // completar novedades con `after`
      'subscribeToConversation', // Realtime
      'fusionar', // deduplicación
      'reconciliarEnvio', // interfaz optimista
      'descartarEnvio', // descartar un envío fallido
      'nuevoIdTemporal', // burbuja provisional
      'marcarConversacionLeida', // leídos (y la bandeja se entera: `lib/bandeja.ts`)
      'hayMasHistorial', // fin del historial
      'ultimoEnvio', // reintento con lo mismo
    ]) {
      assert.ok(CHAT.includes(pieza), `ChatScreen ha perdido: ${pieza}`);
    }
  });

  it('el teclado sigue sin tapar el redactor', () => {
    /*
      Nada de márgenes a mano. En Android la aplicación es `edgeToEdgeEnabled`,
      así que la ventana NO se reajusta sola al abrirse el teclado: hace falta
      el componente que encoge el contenedor. Lo mismo en el visor de historias,
      que ahora también escribe.
    */
    assert.ok(CHAT.includes('<SinTecladoDelante>'), 'ChatScreen ya no evita el teclado.');
    assert.ok(
      VISOR.includes('SinTecladoDelante'),
      'El visor de historias escribe y no evita el teclado: en Android el ' +
        'campo de respuesta queda literalmente debajo.',
    );
  });

  it('la barra del redactor sigue respetando la zona de gestos', () => {
    assert.ok(
      /paddingBottom: spacing\.lg \+ insets\.bottom/.test(CHAT),
      'El campo vuelve a quedar bajo la barra de gestos.',
    );
  });
});
