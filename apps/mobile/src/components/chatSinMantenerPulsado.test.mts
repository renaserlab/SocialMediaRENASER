import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Las dos cosas del chat que ya se rompieron una vez, y no de forma ruidosa.
 *
 * 1. LA NOTA DE VOZ NO SE ENVIABA. El micrófono era «mantener pulsado» y el
 *    envío colgaba de `onFinalize` del gesto. Ese evento se dispara también
 *    cuando el gesto FALLA o lo cancela el sistema —y el diálogo de permiso del
 *    micrófono lo cancela SIEMPRE la primera vez—, así que el `soltar` llegaba
 *    con la grabadora todavía arrancando y se iba de vacío por su primera
 *    línea (`if (fase !== 'grabando') return;`). Después `empezar()` terminaba,
 *    ponía la fase en «grabando» y dejaba el micrófono abierto sin nadie
 *    delante: a partir de ahí ni se grababa ni se enviaba nada más.
 *
 * 2. LA CABECERA TENÍA UNA CÁMARA DE VIDEOLLAMADA QUE NO ABRÍA NADA, y el
 *    nombre que enseñaba venía de un parámetro de navegación, así que no había
 *    forma de abrir el perfil de la persona con la que se habla.
 *
 * SE MIRA EL CÓDIGO FUENTE, como en `notasDeVozYRespuestasAHistorias.test.mts`
 * y `grabadoraNoTocaLoLiberado.test.mts`: montar la pantalla pediría un
 * renderizador de React Native que este proyecto no tiene en las pruebas, y lo
 * que hay que impedir no es un número mal calculado sino que vuelva a colarse
 * un patrón que ya costó caro.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

/** El código sin comentarios: aquí se habla mucho del fallo, y por su nombre. */
function sinComentarios(codigo: string): string {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const CHAT = fuente('screens/ChatScreen.tsx');
const BOTON = fuente('components/BotonDeNotaDeVoz.tsx');
const GRABADORA = fuente('hooks/useGrabadoraDeVoz.ts');
const CABECERA = fuente('components/CabeceraDeChat.tsx');

const BOTON_CODIGO = sinComentarios(BOTON);
const GRABADORA_CODIGO = sinComentarios(GRABADORA);
const CHAT_CODIGO = sinComentarios(CHAT);

// ---------------------------------------------------------------------------
// 1. Nada de «mantener pulsado», y nada de enviar al soltar
// ---------------------------------------------------------------------------
describe('el micrófono se pulsa, no se mantiene', () => {
  it('no queda ni un gesto de pulsación larga en el redactor de voz', () => {
    /*
      El gesto era la causa: un `LongPress` cuyo `onFinalize` era el ÚNICO
      camino de envío. Mientras exista, el envío vuelve a depender de un evento
      que el sistema puede disparar cuando le convenga.
    */
    for (const prohibido of [
      'Gesture.LongPress',
      'GestureDetector',
      'onLongPress',
      'MS_PARA_EMPEZAR',
      'runOnJS',
    ]) {
      assert.ok(
        !BOTON_CODIGO.includes(prohibido),
        `BotonDeNotaDeVoz vuelve a usar \`${prohibido}\`: el envío no puede ` +
          'colgar de un gesto que el sistema cancela solo.',
      );
    }
  });

  it('el botón arranca con un toque y para con otro', () => {
    assert.ok(
      /onPress=\{empezar\}/.test(BOTON_CODIGO),
      'Falta el toque que empieza a grabar.',
    );
    assert.ok(
      /onPress=\{detener\}/.test(BOTON_CODIGO),
      'Falta el botón de detener: sin él, la única forma de terminar sería ' +
        'levantar un dedo que ya no hay que mantener.',
    );
    assert.ok(
      /onPress=\{enviar\}/.test(BOTON_CODIGO),
      'Enviar tiene que ser un toque propio sobre una nota ya grabada.',
    );
    assert.ok(
      /onPress=\{eliminar\}/.test(BOTON_CODIGO),
      'Falta la papelera de la previa: hay que poder tirarla sin mandarla.',
    );
  });

  it('la grabadora ya no expone `soltar`', () => {
    // Era la función que enviaba al levantar el dedo. Que no vuelva por la
    // puerta de atrás con el mismo nombre y el mismo trabajo.
    assert.ok(
      !/\bsoltar\b/.test(GRABADORA_CODIGO),
      'Vuelve a haber un `soltar` en la grabadora.',
    );
    assert.ok(
      !/\bsoltar\b/.test(CHAT_CODIGO),
      'La pantalla vuelve a llamar a `soltar`.',
    );
  });

  it('ningún texto sigue diciendo «mantén pulsado» para grabar', () => {
    /*
      Un texto que explica un gesto que ya no existe deja a quien lo lee peor
      que sin texto. El de eliminar un mensaje SÍ sigue siendo una pulsación
      larga y no se toca (`chat.holdForActions`).
    */
    // Sin comentarios: la cabecera de esos ficheros explica el gesto viejo y
    // por qué se fue, y una prueba que fallara por leer su propia explicación
    // obligaría a borrar el motivo para pasar.
    assert.equal(
      /[Mm]ant[ée]n pulsado/.test(GRABADORA_CODIGO),
      false,
      'La grabadora sigue pidiendo mantener pulsado.',
    );
    assert.equal(
      /[Mm]ant[ée]n pulsado/.test(BOTON_CODIGO),
      false,
      'El botón sigue pidiendo mantener pulsado.',
    );
    for (const clave of ['chat.holdToRecord', 'chat.slideToCancel', 'chat.releaseToCancel']) {
      assert.ok(
        !BOTON.includes(clave),
        `El redactor de voz sigue usando \`${clave}\`, que describe el gesto viejo.`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 2. La máquina de estados, con nombre y por escrito
// ---------------------------------------------------------------------------
describe('la máquina de estados de la nota de voz', () => {
  it('tiene las siete fases declaradas', () => {
    for (const fase of [
      "'inactiva'",
      "'permiso'",
      "'grabando'",
      "'guardando'",
      "'lista'",
      "'enviando'",
      "'fallida'",
    ]) {
      assert.ok(
        GRABADORA_CODIGO.includes(`| ${fase}`),
        `Falta la fase ${fase} en \`FaseDeNotaDeVoz\`.`,
      );
    }
  });

  it('empezar comprueba que sigue habiendo alguien esperando', () => {
    /*
      AQUÍ ESTABA EL FALLO. Entre el toque y el micrófono abierto hay cuatro
      llamadas nativas esperadas, y en ese hueco cabe un «cancelar», un salir de
      la pantalla o un paso a segundo plano. Sin estas comprobaciones el
      micrófono se abría DESPUÉS de que nadie lo esperara y ya no se cerraba.
    */
    const empezar = GRABADORA_CODIGO.slice(
      GRABADORA_CODIGO.indexOf('const empezar ='),
      GRABADORA_CODIGO.indexOf('const parar ='),
    );
    assert.ok(empezar.length > 0, 'no se encontró `empezar`');
    assert.equal(
      (empezar.match(/abandonar\.current \|\| !montado\.current/g) ?? []).length,
      2,
      'Hacen falta las DOS comprobaciones: una después del permiso y otra ' +
        'después de preparar el grabador.',
    );
  });

  it('detener conserva lo grabado y no envía nada', () => {
    const detener = GRABADORA_CODIGO.slice(
      GRABADORA_CODIGO.indexOf('const detener ='),
      GRABADORA_CODIGO.indexOf('const cancelar ='),
    );
    assert.ok(/parar\(false\)/.test(detener), 'Detener tiene que parar sin cancelar.');
    assert.ok(
      !/alEnviar|enviar\(/.test(detener),
      'Detener vuelve a enviar: la nota tiene que quedarse en la previa.',
    );
    assert.ok(
      /setFase\('lista'\)/.test(GRABADORA_CODIGO),
      'Nada deja la máquina en la previa.',
    );
  });

  it('enviar solo se puede entrar desde la previa o desde un fallo', () => {
    /*
      Es la guarda que garantiza que el mensaje se inserta EXACTAMENTE UNA VEZ:
      mientras vale «enviando», volver a pulsar no hace nada, así que no hay
      forma de lanzar dos subidas de la misma grabación.
    */
    const enviar = GRABADORA_CODIGO.slice(
      GRABADORA_CODIGO.indexOf('const enviar ='),
      GRABADORA_CODIGO.indexOf('useEffect(() => {', GRABADORA_CODIGO.indexOf('const enviar =')),
    );
    assert.ok(
      /if \(fase !== 'lista' && fase !== 'fallida'\) return;/.test(enviar),
      'Falta la guarda que impide enviar dos veces la misma nota.',
    );
    assert.ok(
      /setFase\('enviando'\)/.test(enviar),
      'Enviar tiene que bloquear la interfaz mientras sube.',
    );
  });

  it('un fallo CONSERVA la grabación y ofrece reintentar', () => {
    /*
      Lo que cuesta rehacer es haberla dicho, no pulsar enviar. Antes de esto,
      un fallo de red dejaba la burbuja muerta en la conversación y el audio se
      perdía.
    */
    const enviar = GRABADORA_CODIGO.slice(GRABADORA_CODIGO.indexOf('const enviar ='));
    const finalDelEnvio = enviar.slice(0, enviar.indexOf('useEffect'));
    assert.ok(
      /setFase\('fallida'\)/.test(finalDelEnvio),
      'Un envío que no se confirma tiene que dejar la máquina en `fallida`.',
    );
    // La nota SOLO se suelta cuando el servidor confirma.
    const soltarLaNota = [...finalDelEnvio.matchAll(/setNota\(null\)/g)].length;
    assert.equal(
      soltarLaNota,
      1,
      'La grabación se suelta en más de un sitio del envío: en el camino de ' +
        'fallo tiene que quedarse entera.',
    );
    assert.ok(
      /if \(confirmado\) \{/.test(finalDelEnvio),
      'Sólo una confirmación del servidor puede dar el envío por bueno.',
    );
    assert.ok(
      /fase === 'fallida' \? t\('common\.retry'\)/.test(BOTON_CODIGO),
      'El botón no ofrece reintentar tras un fallo.',
    );
  });

  it('la pantalla le dice a la máquina si el servidor confirmó', () => {
    /*
      Sin el booleano, un fallo de red dejaría la nota como enviada y quien
      habló no se enteraría. `true` es lo único que suelta la grabación.
    */
    assert.ok(
      /alEnviar: enviarNotaDeVoz/.test(CHAT_CODIGO),
      'La pantalla ya no le pasa a la grabadora cómo enviar.',
    );
    const envio = CHAT_CODIGO.slice(
      CHAT_CODIGO.indexOf('const enviarNotaDeVoz ='),
      CHAT_CODIGO.indexOf('const grabadora ='),
    );
    assert.ok(/return true;/.test(envio) && /return false;/.test(envio));
    assert.ok(
      /descartarEnvio\(mensajesRef\.current, idTemporal\)/.test(envio),
      'Si falla, la burbuja provisional tiene que RETIRARSE: el reintento vive ' +
        'en la barra de voz, y dos botones para el mismo envío son dos mensajes.',
    );
    assert.ok(
      /reconciliarEnvio\(mensajesRef\.current, idTemporal, guardado\)/.test(envio),
      'Si sale bien, la provisional se sustituye por la del servidor: es lo ' +
        'que deja el mensaje exactamente una vez.',
    );
  });

  it('salir de la pantalla o irse al fondo no deja el micrófono abierto', () => {
    assert.ok(
      /AppState\.addEventListener\('change'/.test(GRABADORA_CODIGO),
      'Nadie escucha el paso a segundo plano: en Android el sistema puede ' +
        'matar la grabación sin avisar y la pantalla seguiría diciendo que graba.',
    );
    assert.ok(
      /if \(fase === 'grabando'\) void detener\(\);/.test(GRABADORA_CODIGO),
      'Al irse al fondo hay que PARAR y conservar lo dicho, no descartarlo.',
    );
    // Y la limpieza de desmontaje sigue sin tocar nada nativo (ver
    // `grabadoraNoTocaLoLiberado.test.mts`); aquí sólo se exige que corte una
    // secuencia de arranque que siguiera en vuelo.
    const desmontaje = GRABADORA_CODIGO.slice(GRABADORA_CODIGO.lastIndexOf('return () => {'));
    assert.ok(
      /abandonar\.current = true;/.test(desmontaje),
      'Al desmontar hay que abortar un `empezar` en vuelo: si no, el micrófono ' +
        'se abre detrás de una pantalla que ya no existe.',
    );
  });

  it('la duración y el formato se validan antes de subir nada', () => {
    assert.ok(
      /decidirDesenlace\(\{ ms, cancelada \}\)/.test(GRABADORA_CODIGO),
      'Se ha perdido la comprobación de duración mínima, que es código puro y ' +
        'con pruebas (`lib/notaDeVoz.ts`).',
    );
    assert.ok(
      /Math\.min\(ms, MAX_DURACION_S \* 1000\)/.test(GRABADORA_CODIGO),
      'La duración que viaja al backend puede pasarse del tope y tirar la ' +
        'subida entera después de hacerla.',
    );
    assert.ok(
      /EXTENSIONES_DE_AUDIO/.test(GRABADORA_CODIGO),
      'Nadie comprueba que lo que escribió el grabador se pueda nombrar como ' +
        'audio: el bucket `message-media` sólo admite `audio/*`.',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. La cabecera: sin videollamada, con la persona
// ---------------------------------------------------------------------------
describe('la cabecera del chat', () => {
  it('ya no pinta el icono de videollamada', () => {
    /*
      Era `rightIcon="video"` SIN `onRightPress`: un icono que no abría nada,
      porque no hay videollamadas en esta aplicación. Un botón que no responde
      es peor que su ausencia: quien lo pulsa concluye que está roto.
    */
    assert.ok(
      !/rightIcon="video"/.test(CHAT_CODIGO),
      'Ha vuelto la cámara de videollamada a la cabecera del chat.',
    );
    assert.ok(
      !/rightIcon/.test(sinComentarios(CABECERA)),
      'La cabecera del chat no tiene ninguna acción derecha que ofrecer.',
    );
  });

  it('la cámara del selector de ADJUNTOS sigue estando', () => {
    // Ésa sí funciona: hace una foto y la manda. Se quitó la de arriba, no ésta.
    assert.ok(
      /leftIcon="camera"/.test(CHAT) && /elegirCon\(hacerFoto\)/.test(CHAT),
      'Se ha llevado por delante la cámara del menú de adjuntos, que sí funciona.',
    );
  });

  it('enseña a la persona y abre su perfil POR IDENTIFICADOR', () => {
    assert.ok(/<Avatar/.test(CABECERA), 'Falta la foto del otro participante.');
    assert.ok(
      /accessibilityRole=\{idDelPerfil \? 'button' : undefined\}/.test(CABECERA),
      'Foto y nombre tienen que ser UN elemento accesible con rol de botón.',
    );
    assert.ok(
      /irAlPerfil\(router, idDelPerfil\)/.test(CABECERA),
      'Se navega de otra forma que no es el camino con precarga que ya existe.',
    );
  });

  it('el participante se resuelve contra el servidor, no contra la navegación', () => {
    /*
      `/chat/[id]` recibe un `name` que escribe quien navega: puede venir viejo,
      vacío o de otra persona, y no trae identificador con el que abrir ningún
      perfil. Es respaldo, nunca la fuente.
    */
    assert.ok(
      /async function pedirParticipante/.test(CABECERA),
      'Nadie pregunta al servidor con quién se está hablando.',
    );
    assert.ok(
      /remitente\.id !== currentUserId/.test(CABECERA),
      'El otro participante se decide comparando con quien mira, no por el orden.',
    );
    assert.ok(
      /nombreDeRespaldo/.test(CABECERA) && /nombreDeRespaldo={headerName}/.test(CHAT),
      'El nombre del parámetro tiene que entrar como RESPALDO declarado.',
    );
  });

  it('sin identificador no se ofrece abrir nada', () => {
    // Nunca un botón muerto, y nunca navegar «a ver si acierta».
    assert.ok(
      /disabled=\{!idDelPerfil\}/.test(CABECERA),
      'Sin identificador resuelto, la cabecera no puede ser pulsable.',
    );
  });

  it('volver atrás sigue funcionando con enlaces directos', () => {
    assert.ok(
      /router\.canGoBack\(\) \? router\.back\(\) : router\.replace\('\/'\)/.test(CHAT),
      'Se ha perdido la salida de un enlace directo, que deja atrapado a quien ' +
        'llega al chat sin historial.',
    );
  });

  it('AppHeader recibe el contenido central por una prop OPCIONAL', () => {
    /*
      `AppHeader` lo comparten una decena de pantallas. La única forma de
      tocarlo es añadiendo algo que, sin pasarlo, no cambia nada.
    */
    const header = fuente('components/AppHeader.tsx');
    assert.ok(
      /center\?: React\.ReactNode;/.test(header),
      'La prop nueva del header tiene que ser opcional.',
    );
    assert.ok(
      /\{center \? \(\s*\n\s*<View style=\{styles\.center\}>\{center\}<\/View>\s*\n\s*\) : title === 'Z' \? \(/.test(
        header,
      ),
      'Sin `center`, el header tiene que seguir pintando exactamente lo de ' +
        'antes: el logo cuando el título es «Z» y el texto centrado en el resto.',
    );
  });
});
