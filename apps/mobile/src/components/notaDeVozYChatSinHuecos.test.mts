import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { es } from '../i18n/es.ts';
import { en } from '../i18n/en.ts';
import { pt } from '../i18n/pt.ts';

/**
 * Los huecos de la nota de voz y de los estados del chat, cerrados y vigilados.
 *
 * Trece cosas que se arreglaron juntas el 03/10/2026 y que ninguna prueba
 * miraba. Casi todas fallaban EN SILENCIO, que es por lo que duraron:
 *
 *  - conceder el permiso de micrófono por primera vez abortaba la grabación sin
 *    decir nada (el diálogo del sistema saca a la aplicación de «activa» y eso
 *    se leía como «la persona se ha ido»);
 *  - en Android el reloj de la grabación leía `currentTime`, que en
 *    `expo-audio` 1.1.1 devuelve ahí la HORA a la que empezó y no lo que lleva:
 *    el tope de duración saltaba en el primer tic;
 *  - un fallo al arrancar dejaba el grabador preparado y el micrófono muerto;
 *  - abrir un perfil desde la cabecera dejaba el micrófono abierto debajo;
 *  - con dos envíos fallidos, reintentar el primero mandaba el segundo.
 *
 * SE MIRA EL CÓDIGO FUENTE, como en `chatSinMantenerPulsado.test.mts` y
 * `grabadoraNoTocaLoLiberado.test.mts`, y por lo mismo: montar la pantalla
 * pediría un renderizador de React Native y un micrófono que este proyecto no
 * tiene en las pruebas. Esto NO sustituye a probarlo en un teléfono; impide que
 * el arreglo se deshaga sin que nadie lo vea.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

/** Con los finales de línea normalizados: el repositorio se trabaja en CRLF. */
function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
}

/** El código sin comentarios: aquí se habla mucho del fallo, y por su nombre. */
function sinComentarios(codigo: string): string {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** El trozo que va de una marca a la siguiente. Falla si no encuentra alguna. */
function tramo(codigo: string, desde: string, hasta: string): string {
  const inicio = codigo.indexOf(desde);
  assert.notEqual(inicio, -1, `no se encontró \`${desde}\``);
  const fin = codigo.indexOf(hasta, inicio + desde.length);
  assert.notEqual(fin, -1, `no se encontró \`${hasta}\` después de \`${desde}\``);
  return codigo.slice(inicio, fin);
}

const GRABADORA = sinComentarios(fuente('hooks/useGrabadoraDeVoz.ts'));
const BOTON = sinComentarios(fuente('components/BotonDeNotaDeVoz.tsx'));
const CHAT = sinComentarios(fuente('screens/ChatScreen.tsx'));
const PERMISOS = sinComentarios(fuente('lib/permisos.ts'));

const EMPEZAR = tramo(GRABADORA, 'const empezar =', 'const parar =');
const PARAR = tramo(GRABADORA, 'const parar =', 'const detener =');
const ELIMINAR = tramo(GRABADORA, 'const eliminar =', 'const enviar =');
const ENVIAR = tramo(GRABADORA, 'const enviar =', 'useEffect');

// ---------------------------------------------------------------------------
// 1. Se ve que está grabando
// ---------------------------------------------------------------------------
describe('mientras graba hay una señal que se mueve', () => {
  it('la barra de grabación pinta el punto que late, no uno quieto', () => {
    const barra = tramo(BOTON, "{fase === 'grabando' ? (", '{enPrevia ? (');
    assert.match(
      barra,
      /<PuntoQueLate color=\{colors\.danger\} \/>/,
      'La barra de grabación ha vuelto a un punto fijo: quieto no se distingue ' +
        'de un adorno y nada dice que el micrófono está abierto AHORA.',
    );
  });

  it('el latido respeta «reducir movimiento»', () => {
    const punto = tramo(BOTON, 'function PuntoQueLate', 'function NotaSonando');
    assert.match(punto, /const sinMovimiento = useReduceMotion\(\);/);
    const guarda = punto.indexOf('if (sinMovimiento) {');
    const bucle = punto.indexOf('Animated.loop(');
    assert.notEqual(guarda, -1, 'falta la guarda de «reducir movimiento»');
    assert.notEqual(bucle, -1, 'el punto ya no late');
    assert.ok(
      guarda < bucle,
      'La guarda tiene que ir ANTES de arrancar el bucle: si no, quien pidió ' +
        'menos movimiento lo recibe igual.',
    );
    assert.match(punto, /return \(\) => bucle\.stop\(\);/, 'el bucle no se para al desmontar');
  });

  it('el latido no trae de vuelta ningún gesto', () => {
    // Es una animación de opacidad. Si alguien la convierte en un gesto, el
    // envío vuelve a colgar de un evento que el sistema cancela solo.
    for (const prohibido of ['PanResponder', 'onPressIn', 'onPressOut', 'onLongPress']) {
      assert.ok(!BOTON.includes(prohibido), `BotonDeNotaDeVoz usa \`${prohibido}\`.`);
    }
  });
});

// ---------------------------------------------------------------------------
// 2 y 3. Pedir el permiso
// ---------------------------------------------------------------------------
describe('pedir el permiso de micrófono', () => {
  it('el diálogo del sistema no cuenta como irse de la aplicación', () => {
    /*
      Mientras el sistema pregunta, la aplicación pasa a `inactive` (iOS) o a
      `background` (Android). Si eso marca `abandonar`, la primera vez que
      alguien concede el micrófono la grabación se aborta sin decir nada.
    */
    assert.match(
      GRABADORA,
      /if \(fase === 'permiso' && !preguntando\.current\) abandonar\.current = true;/,
      'Irse al fondo durante el diálogo de permiso vuelve a abortar la ' +
        'grabación: conceder el micrófono no puede contar como marcharse.',
    );
    assert.ok(
      !/if \(fase === 'permiso'\) abandonar\.current = true;[\s\S]{0,80}?void detener\(\);\s*\};\s*useEffect/.test(
        GRABADORA,
      ),
      'El oyente de `AppState` ha vuelto a abandonar sin mirar `preguntando`.',
    );
  });

  it('`preguntando` se levanta antes de pedir y se baja SIEMPRE después', () => {
    assert.match(
      EMPEZAR,
      /preguntando\.current = true;\s*try \{\s*permiso = await pedirPermiso\('microfono'\);/,
      'La marca tiene que estar puesta ANTES de que el sistema enseñe el diálogo.',
    );
    assert.match(
      EMPEZAR,
      /\} finally \{\s*preguntando\.current = false;\s*\}/,
      'Si la marca no se baja en un `finally`, un fallo al pedir el permiso ' +
        'dejaría la grabadora sin enterarse de que la aplicación se va al fondo.',
    );
  });

  it('pedir el permiso está dentro de un `try`, y un fallo devuelve la fase', () => {
    assert.equal(
      (EMPEZAR.match(/pedirPermiso\(/g) ?? []).length,
      1,
      'El permiso se pide en más de un sitio.',
    );
    assert.match(
      EMPEZAR,
      /permiso = await pedirPermiso\('microfono'\);\s*\} catch \{\s*setFase\('inactiva'\);\s*alAvisar\(\{[\s\S]{0,200}?\}\);\s*return;\s*\} finally/,
      'Un fallo al pedir el permiso tiene que devolver la fase a «inactiva» y ' +
        'avisar: si no, queda una rueda girando y no se puede volver a grabar.',
    );
  });

  it('con el permiso concedido se sigue hasta grabar', () => {
    const pide = EMPEZAR.indexOf("permiso = await pedirPermiso('microfono');");
    const graba = EMPEZAR.indexOf('grabador.record();');
    assert.ok(pide !== -1 && graba !== -1 && pide < graba);
  });
});

// ---------------------------------------------------------------------------
// 4. El permiso denegado se explica
// ---------------------------------------------------------------------------
describe('un permiso denegado se explica y ofrece los ajustes', () => {
  it('los dos casos tienen su texto, y sale del diccionario', () => {
    for (const clave of [
      'chat.voiceMicNeededTitle',
      'chat.voiceMicNeededBody',
      'chat.voiceMicBlockedTitle',
      'chat.voiceMicBlockedBody',
      'chat.voiceOpenSettings',
    ]) {
      assert.ok(EMPEZAR.includes(`t('${clave}')`), `la grabadora ya no usa \`${clave}\``);
    }
  });

  it('bloqueado lleva a los ajustes del teléfono', () => {
    assert.match(PERMISOS, /Linking\.openSettings\(\)/);
    assert.match(
      CHAT,
      /confirmLabel: aviso\.accion\.texto,[\s\S]{0,120}?if \(ok\) aviso\.accion\?\.alPulsar\(\);/,
      'La pantalla tiene que ofrecer «abrir ajustes» como un botón que hace algo.',
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Salir no deja el micrófono abierto ni pierde la nota en silencio
// ---------------------------------------------------------------------------
describe('salir del chat con una nota a medias', () => {
  const foco = tramo(GRABADORA, 'alPerderElFoco.current = () => {', 'useFocusEffect(');

  it('perder el foco para la grabación y conserva lo dicho', () => {
    /*
      Tocar la cabecera abre el perfil ENCIMA del chat, que sigue montado: sin
      esto la grabación seguía corriendo en una pantalla que nadie miraba.
    */
    assert.match(GRABADORA, /useFocusEffect\(/, 'Nadie escucha la pérdida de foco.');
    assert.match(foco, /if \(fase === 'grabando'\) void detener\(\);/);
    assert.match(foco, /if \(fase === 'permiso'\) abandonar\.current = true;/);
  });

  it('esa limpieza no toca nada nativo al desmontar', () => {
    /*
      `useFocusEffect` ejecuta su limpieza también al desmontar, y ahí el
      grabador ya está liberado: es la regla de
      `grabadoraNoTocaLoLiberado.test.mts`. `montado` lo distingue, y solo vale
      si su limpieza se declaró ANTES que la del foco.
    */
    assert.match(foco, /^alPerderElFoco\.current = \(\) => \{\s*if \(!montado\.current\) return;/);
    assert.ok(!/grabador\./.test(foco), 'la limpieza de foco lee del grabador directamente');
    assert.ok(
      GRABADORA.indexOf('montado.current = false;') < GRABADORA.indexOf('useFocusEffect('),
      'El efecto de `montado` tiene que declararse antes que el de foco: React ' +
        'corre las limpiezas en orden de declaración.',
    );
    assert.ok(
      GRABADORA.indexOf('useFocusEffect(') < GRABADORA.lastIndexOf('return () => {'),
      'La limpieza de desmontaje tiene que seguir siendo la última.',
    );
  });

  it('volver atrás con una nota en juego pregunta antes', () => {
    const salir = tramo(CHAT, 'const salirDelChat =', 'const ultimaSalida =');
    const pregunta = salir.indexOf('await confirm({');
    const navega = salir.indexOf('router.canGoBack()');
    assert.ok(pregunta !== -1 && navega !== -1 && pregunta < navega);
    assert.match(salir, /if \(notaEnJuego\) \{/);
    assert.match(salir, /if \(!ok\) return;/, 'Decir que no tiene que dejar a la persona en el chat.');
    assert.match(
      salir,
      /if \(actual\.fase === 'grabando'\) await actual\.cancelar\(\);\s*else actual\.eliminar\(\);/,
      'Al confirmar, la nota se descarta por su camino: es lo que cierra el ' +
        'micrófono y borra el fichero ANTES de navegar.',
    );
    assert.match(CHAT, /onBack=\{\(\) => void salirDelChat\(\)\}/);
  });

  it('la tecla Atrás de Android pasa por la misma pregunta', () => {
    assert.match(
      CHAT,
      /useFocusEffect\(\s*useCallback\(\(\) => \{\s*if \(!notaEnJuego\) return undefined;\s*return registrarSalidaPropia\(\(\) => ultimaSalida\.current\(\)\);\s*\}, \[notaEnJuego\]\),\s*\);/,
      'Sin el registro, la tecla física vuelve sin preguntar. Y registrado sin ' +
        'nota en juego, esta pantalla se quedaría un Atrás que no le toca.',
    );
  });

  it('«enviando» no cuenta como nota que se pierde', () => {
    const enJuego = tramo(CHAT, 'const notaEnJuego =', 'const grabadoraActual');
    for (const fase of ["'grabando'", "'lista'", "'fallida'"]) {
      assert.ok(enJuego.includes(fase), `falta ${fase} en \`notaEnJuego\``);
    }
    assert.ok(
      !enJuego.includes("'enviando'"),
      'La subida sigue aunque la pantalla se cierre: preguntar ahí sería ' +
        'ofrecer descartar algo que se va a enviar igual.',
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Un arranque fallido suelta el grabador
// ---------------------------------------------------------------------------
describe('si falla el arranque de la grabación', () => {
  it('se llama a `cerrar()`, no solo se devuelve la sesión', () => {
    /*
      Si lo que falla es `record()`, el grabador ya estaba PREPARADO. Sin
      `stop()` se queda así y el siguiente intento lanza «AudioRecorder has
      already been prepared»: el micrófono muerto hasta salir del chat.
    */
    assert.match(
      EMPEZAR,
      /grabador\.record\(\);\s*setFase\('grabando'\);\s*\} catch \{\s*await cerrar\(\);\s*setFase\('inactiva'\);\s*alAvisar\(/,
    );
    const cerrar = tramo(GRABADORA, 'const cerrar =', 'const empezar =');
    assert.match(cerrar, /try \{\s*await grabador\.stop\(\);\s*\} catch \{/);
    assert.match(cerrar, /await permitirGrabar\(false\);/);
  });
});

// ---------------------------------------------------------------------------
// 7. El fichero temporal
// ---------------------------------------------------------------------------
describe('el fichero de la grabación no se queda en la caché', () => {
  it('se borra con la misma llamada que ya usa `storage.ts`, y nunca lanza', () => {
    const borrar = tramo(GRABADORA, 'async function borrarGrabacion', 'export function useGrabadoraDeVoz');
    assert.match(
      borrar,
      /try \{\s*const legacy = await import\('expo-file-system\/legacy'\);\s*await legacy\.deleteAsync\(uri, \{ idempotent: true \}\);\s*\} catch \{/,
    );
    assert.match(borrar, /if \(!uri \|\| Platform\.OS === 'web'\) return;/);
  });

  it('cancelar y «muy corta» lo borran antes de volver a «inactiva»', () => {
    assert.equal((PARAR.match(/await tirarFichero\(uri\);/g) ?? []).length, 2);
    for (const desenlace of ["'descartar'", "'demasiado-corta'"]) {
      const rama = tramo(PARAR, `if (desenlace === ${desenlace}) {`, 'return;');
      assert.ok(
        rama.indexOf('await tirarFichero(uri);') !== -1 &&
          rama.indexOf('await tirarFichero(uri);') < rama.indexOf("setFase('inactiva');"),
        `la rama ${desenlace} no borra el fichero antes de dejar grabar otra nota`,
      );
    }
  });

  it('la papelera de la previa lo borra', () => {
    assert.match(ELIMINAR, /void tirarFichero\(nota\?\.uri\);/);
  });

  it('enviar lo borra SOLO cuando el servidor confirma', () => {
    /*
      Tras un fallo el fichero es lo único que permite reintentar sin volver a
      hablar. Un borrado sin condición convertiría «reintentar» en un botón que
      sube un fichero que ya no existe.
    */
    assert.equal(
      (ENVIAR.match(/tirarFichero\(/g) ?? []).length,
      1,
      'El envío borra el fichero en más de un sitio.',
    );
    assert.match(ENVIAR, /if \(confirmado\) await tirarFichero\(pendiente\.uri\);/);
  });

  it('una nota nueva espera a que termine el borrado de la anterior', () => {
    /*
      En iOS el grabador escribe siempre en la misma ruta: un borrado que
      aterrizara tarde se llevaría la nota que se está grabando.
    */
    const espera = EMPEZAR.indexOf('await limpieza.current;');
    const prepara = EMPEZAR.indexOf('await grabador.prepareToRecordAsync();');
    assert.ok(espera !== -1 && prepara !== -1 && espera < prepara);
    assert.match(
      GRABADORA,
      /limpieza\.current = limpieza\.current\.then\(\(\) => borrarGrabacion\(uri\)\);/,
      'Los borrados tienen que ir en fila: es lo que `empezar` espera.',
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Los textos salen del diccionario, en los tres idiomas
// ---------------------------------------------------------------------------
describe('los textos de la nota de voz', () => {
  const CLAVES = [
    'chat.voiceMicBlockedTitle',
    'chat.voiceMicBlockedBody',
    'chat.voiceOpenSettings',
    'chat.voiceMicNeededTitle',
    'chat.voiceMicNeededBody',
    'chat.voiceStartFailedTitle',
    'chat.voiceStartFailedBody',
    'chat.voiceTooShortTitle',
    'chat.voiceTooShortBody',
    'chat.voiceSaveFailedTitle',
    'chat.voiceSaveFailedBody',
    'chat.voiceLeaveTitle',
    'chat.voiceLeaveBody',
    'chat.voiceLeaveConfirm',
    'chat.emptyTitle',
    'chat.emptyBody',
    'chat.openFile',
  ] as const;

  it('están en español, inglés y portugués', () => {
    for (const [idioma, diccionario] of [
      ['es', es],
      ['en', en],
      ['pt', pt],
    ] as const) {
      const d = diccionario as Record<string, string>;
      for (const clave of CLAVES) {
        assert.ok(d[clave]?.trim(), `falta \`${clave}\` en ${idioma}`);
      }
    }
  });

  it('la grabadora no lleva frases escritas a mano', () => {
    /*
      Una frase es un literal con espacios. Los únicos literales que le quedan
      a la grabadora son fases, extensiones, tipos y claves del diccionario, y
      ninguno lleva espacios.
    */
    const cuerpo = GRABADORA.slice(GRABADORA.indexOf('export function useGrabadoraDeVoz'));
    const frases = [...cuerpo.matchAll(/'([^'\n]*)'/g)]
      .map((m) => m[1] ?? '')
      .filter((literal) => /\s/.test(literal));
    assert.deepEqual(frases, [], 'hay textos en duro en la grabadora');
  });

  it('todo aviso de la grabadora lleva título y cuerpo traducidos', () => {
    const avisos = [...GRABADORA.matchAll(/alAvisar\(\{([\s\S]*?)\}\);/g)].map((m) => m[1] ?? '');
    assert.ok(avisos.length >= 5, `solo se encontraron ${avisos.length} avisos`);
    for (const aviso of avisos) {
      assert.match(aviso, /titulo:[\s\S]*?t\('chat\.voice/, `aviso sin título traducido:\n${aviso}`);
      assert.match(aviso, /cuerpo:[\s\S]*?t\('chat\.voice/, `aviso sin cuerpo traducido:\n${aviso}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Lo que tiene que verse en cada fase
// ---------------------------------------------------------------------------
describe('la duración y las acciones de cada fase', () => {
  it('el reloj lee `durationMillis`, no `currentTime`', () => {
    /*
      En `expo-audio` 1.1.1, `currentTime` del grabador solo es la duración en
      iOS. En Android el módulo nativo devuelve ahí `startTime`, la HORA a la
      que empezó la grabación: multiplicada por mil pasa del tope de duración en
      el primer tic y la nota se para sola.
    */
    assert.ok(
      !/grabador\.currentTime/.test(GRABADORA),
      'Vuelve a leerse `grabador.currentTime`: en Android no es la duración.',
    );
    assert.match(
      GRABADORA,
      /const estado = grabador\.getStatus\(\);\s*setMilisegundos\(estado\.durationMillis \?\? 0\);/,
    );
    // Y EL MISMO RELOJ EN EL AUDIO DE PRESENTACIÓN DEL PERFIL: allí el tope es
    // de un minuto y se cortaba igual, en el primer tic.
    const INTRO = sinComentarios(fuente('components/AudioDePresentacion.tsx'));
    assert.ok(
      !/grabadora\.currentTime/.test(INTRO),
      'El audio de presentación vuelve a leer `grabadora.currentTime`.',
    );
    assert.match(INTRO, /setMsGrabados\(grabadora\.getStatus\(\)\.durationMillis \?\? 0\);/);
    // En ningún otro sitio se lee el `currentTime` de algo que graba.
    for (const [nombre, codigo] of [['grabadora', GRABADORA], ['presentación', INTRO]] as const) {
      assert.ok(!/useAudioRecorder[\s\S]*\b(grabador|grabadora)\.currentTime/.test(codigo), nombre);
    }
    const mide = PARAR.indexOf('const medido = grabador.getStatus().durationMillis;');
    const cierra = PARAR.indexOf('await cerrar();');
    assert.ok(
      mide !== -1 && cierra !== -1 && mide < cierra,
      'La duración se lee ANTES de parar: después el grabador ya cuenta cero.',
    );
  });

  it('grabando: reloj y cancelar', () => {
    const barra = tramo(BOTON, "{fase === 'grabando' ? (", '{enPrevia ? (');
    assert.match(barra, /formatearDuracion\(segundos\)/);
    assert.match(barra, /onPress=\{cancelar\}/);
    assert.match(barra, /t\('chat\.recording'\)/);
  });

  it('previa: escuchar, duración, eliminar y el motivo del fallo', () => {
    const previa = tramo(BOTON, '{enPrevia ? (', "{fase === 'enviando' ? (");
    assert.match(previa, /onPress=\{\(\) => setSonando\(true\)\}/, 'no se puede escuchar antes de enviar');
    assert.match(previa, /<NotaSonando uri=\{uri\}/);
    assert.match(previa, /formatearDuracion\(segundos\)/);
    assert.match(previa, /onPress=\{eliminar\}/);
    assert.match(
      previa,
      /fase === 'fallida' \? t\('chat\.recordingFailed'\) : t\('chat\.recordingReady'\)/,
    );
  });

  it('enviando: se dice y se ve el avance', () => {
    const subida = BOTON.slice(BOTON.indexOf("{fase === 'enviando' ? ("));
    assert.match(subida.slice(0, 900), /t\('chat\.recordingSending'\)/);
    assert.match(subida.slice(0, 900), /Math\.min\(1, progreso\)/);
  });
});

// ---------------------------------------------------------------------------
// 10. Cargando, vacío y error al abrir la conversación
// ---------------------------------------------------------------------------
describe('los estados de la conversación al abrirla', () => {
  it('la lista sin mensajes dice si carga, si falló o si está vacía', () => {
    assert.match(
      CHAT,
      /ListEmptyComponent=\{\s*supabaseEnabled && cargandoMensajes \? \(\s*<StateView state="loading" \/>/,
      'Abrir un chat vuelve a enseñar una pantalla en blanco mientras carga.',
    );
    assert.match(
      CHAT,
      /<StateView\s+state="error"[\s\S]{0,160}?onRetry=\{\(\) => setIntentoDeCarga\(\(intento\) => intento \+ 1\)\}/,
      'Un fallo de carga tiene que poder reintentarse sin salir del chat.',
    );
    assert.match(
      CHAT,
      /<StateView\s+state="empty"[\s\S]{0,120}?title=\{t\('chat\.emptyTitle'\)\}/,
      'Una conversación sin mensajes tiene que decirlo.',
    );
  });

  it('«cargando» empieza encendido y se apaga pase lo que pase', () => {
    assert.match(
      CHAT,
      /const \[cargandoMensajes, setCargandoMensajes\] = useState\(\s*supabaseEnabled && !!params\.id,\s*\);/,
      'Si no empieza en `true`, el primer fotograma es el de «vacío».',
    );
    assert.match(
      CHAT,
      /\.finally\(\(\) => \{\s*if \(montado\) setCargandoMensajes\(false\);\s*\}\);/,
      'Sin el `finally`, una carga fallida deja la rueda girando para siempre.',
    );
  });

  it('reintentar vuelve a lanzar la carga, limpia', () => {
    assert.match(
      CHAT,
      /setCargandoMensajes\(true\);\s*setLoadError\(null\);\s*const cargaInicial = MessageRepository\.listMessages\(conversationId, currentUserId\)/,
    );
    assert.match(
      CHAT,
      /\}, \[supabaseEnabled, params\.id, currentUserId, aplicar, intentoDeCarga\]\);/,
      '`intentoDeCarga` tiene que estar en las dependencias: es lo que relanza.',
    );
  });

  it('el redactor sigue ahí en los tres estados', () => {
    // Los estados viven DENTRO de la lista. Un `return` temprano de la pantalla
    // se llevaría el campo de texto, y en una conversación nueva «vacío» es
    // justo desde donde se escribe el primer mensaje.
    const pintado = CHAT.slice(CHAT.indexOf('<SinTecladoDelante>'));
    assert.ok(pintado.indexOf('ListEmptyComponent=') < pintado.indexOf('styles.inputBar'));
    assert.ok(!/if \(cargandoMensajes\)\s*\{?\s*return/.test(CHAT));
  });
});

// ---------------------------------------------------------------------------
// 11. El reintento es de cada burbuja
// ---------------------------------------------------------------------------
describe('reintentar un envío fallido', () => {
  it('cada burbuja guarda lo suyo', () => {
    /*
      Con un solo hueco, dos fallos seguidos se pisaban: reintentar el PRIMERO
      mandaba el contenido del SEGUNDO con el identificador del primero.
    */
    assert.match(CHAT, /const ultimoEnvioDe = useRef\(new Map<string, EnvioPendiente>\(\)\);/);
    assert.match(CHAT, /ultimoEnvioDe\.current\.set\(idTemporal, envio\);/);
    assert.match(CHAT, /const envio = ultimoEnvioDe\.current\.get\(mensaje\.id\);/);
    assert.ok(
      !/ultimoEnvio\.current/.test(CHAT),
      'Ha vuelto la referencia única: el segundo fallo pisa al primero.',
    );
  });

  it('lo guardado se suelta al enviar bien y al descartar', () => {
    assert.match(CHAT, /ultimoEnvioDe\.current\.delete\(idTemporal\);/);
    assert.match(CHAT, /ultimoEnvioDe\.current\.delete\(mensaje\.id\);/);
  });

  it('el reintento usa el identificador de la misma burbuja', () => {
    const reintentar = tramo(CHAT, 'const reintentar =', 'const descartar =');
    assert.match(reintentar, /await enviar\(envio, mensaje\.id\);/);
  });
});

// ---------------------------------------------------------------------------
// 12. Los adjuntos que no son una imagen
// ---------------------------------------------------------------------------
describe('abrir un vídeo o un documento', () => {
  it('un vídeo no va al visor de imágenes', () => {
    // Desde el 10/10 el vídeo se reproduce DENTRO de la aplicación (antes se
    // abría fuera). Lo que no cambia es el motivo de esta prueba: a
    // `ImageViewer` nunca le llega un vídeo, porque con uno enseña una pantalla
    // negra. `VisorDeAdjunto` lo reproduce él y solo le pasa las imágenes.
    assert.match(
      CHAT,
      /if \(adjunto\.kind === 'video' && !estaEnElServidor\(adjunto\)\) return;\s*if \(adjunto\.url\) setFotoAmpliada\(adjunto\);/,
    );
    const visor = fuente('components/chat/VisorDeAdjunto.tsx');
    assert.match(visor, /if \(adjunto\?\.kind === 'video' && adjunto\.url\) \{/);
    assert.match(
      visor,
      /uri=\{adjunto\?\.kind === 'image' \? adjunto\.url \?\? null : null\}/,
      '`ImageViewer` pinta una imagen: con un vídeo enseña una pantalla negra.',
    );
  });

  it('un archivo se descarga dentro; si es una foto, se ve en el visor', () => {
    // Desde el 12/10 un archivo ya no se abre fuera: lleva su botón de
    // descargar (`ArchivoDeChat`). Lo que no cambia es que, mientras sube,
    // no se ofrece nada: solo hay una ruta de este teléfono.
    const documento = tramo(CHAT, "if (adjunto.kind === 'document') {", 'const proporcion =');
    assert.match(documento, /<ArchivoDeChat\s+key=\{adjunto\.id\}\s+adjunto=\{adjunto\}/);
    assert.match(
      documento,
      /const medio = estaEnElServidor\(adjunto\)\s*\? medioQueEs\(adjunto\.mimeType, adjunto\.fileName\)\s*: null;/,
    );
    assert.match(
      documento,
      /alVer=\{medio \? \(\) => setFotoAmpliada\(\{ \.\.\.adjunto, kind: medio \}\) : undefined\}/,
    );
    const archivo = fuente('components/chat/ArchivoDeChat.tsx');
    assert.match(archivo, /const disponible = !!adjunto\.url && adjunto\.url\.startsWith\('http'\);/);
    assert.match(
      archivo,
      /disabled=\{!disponible\}/,
      'Mientras sube solo hay una ruta local: un botón que no hace nada no se ofrece.',
    );
  });

  it('nada del chat se abre fuera de la aplicación', () => {
    assert.match(CHAT, /return !!adjunto\.url && adjunto\.url\.startsWith\('http'\);/);
    // Lo visto en teléfono el 12/10: tocar un archivo abría una pestaña de
    // Chrome con la dirección del almacén.
    assert.doesNotMatch(CHAT, /Linking\.openURL|abrirFuera/);
    const descarga = fuente('services/descargarArchivo.ts');
    assert.match(
      descarga,
      /\} catch \{\s*return \{ estado: 'fallo' \};\s*\} finally \{/,
      'Si no se puede descargar hay que decirlo, no callar ni lanzar.',
    );
  });
});

// ---------------------------------------------------------------------------
// 13. La conversación se abre por el final
// ---------------------------------------------------------------------------
describe('la lista queda anclada abajo', () => {
  it('usa el modo de chat de FlashList, sin invertir la lista', () => {
    assert.match(
      CHAT,
      /maintainVisibleContentPosition=\{\{\s*startRenderingFromBottom: true,\s*autoscrollToBottomThreshold: 0\.2,\s*\}\}/,
      'La conversación vuelve a abrirse por el mensaje más antiguo de la página.',
    );
    assert.ok(
      !/\binverted\b/.test(CHAT),
      'Una lista invertida cambia de sentido la paginación del historial y las ' +
        'cabeceras de día, que se calculan contra el mensaje anterior.',
    );
  });
});
