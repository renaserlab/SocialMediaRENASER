import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { RecordingPresets, useAudioRecorder } from 'expo-audio';
import { useFocusEffect } from 'expo-router';

import { permitirGrabar } from '@/hooks/useBackgroundAudio';
import { useTranslation } from '@/i18n/useTranslation';
import {
  decidirDesenlace,
  duracionEnSegundos,
  llegoAlTope,
  MAX_DURACION_S,
  nivelDeVoz,
} from '@/lib/notaDeVoz';
import {
  abrirAjustes,
  pedirPermiso,
  textoDePermiso,
  type EstadoDePermiso,
} from '@/lib/permisos';
import type { AdjuntoElegido } from '@/services/messageMedia';

/**
 * Grabar una nota de voz con el micrófono, sin que la pantalla sepa de audio.
 *
 * =============================================================================
 * POR QUÉ ESTO YA NO ES «MANTENER PULSADO», Y POR QUÉ LA NOTA NO SE ENVIABA
 * =============================================================================
 * Antes el micrófono era un `Gesture.LongPress`: empezaba al mantener y ENVIABA
 * AL SOLTAR. El envío colgaba entero de un evento del gesto, y esa era la
 * causa del fallo, no un síntoma:
 *
 *   `soltar()` empezaba con `if (fase !== 'grabando') return;`
 *
 * y entre el momento en que el gesto se activaba (250 ms) y el momento en que
 * `fase` valía `'grabando'` había CUATRO llamadas nativas encadenadas y
 * esperadas: `consultarPermiso`, el diálogo del sistema si tocaba,
 * `permitirGrabar(true)` (que por dentro configura la sesión de audio dos
 * veces) y `prepareToRecordAsync`. Si el dedo se levantaba dentro de esa
 * ventana —y la
 * PRIMERA VEZ se levanta siempre, porque el diálogo de permiso del sistema roba
 * el toque y cancela el gesto, lo que dispara `onFinalize` en el acto— pasaba
 * lo siguiente:
 *
 *   1. `soltar()` salía por esa primera línea sin grabar, sin enviar y sin
 *      decir nada;
 *   2. `empezar()` terminaba después y ponía `fase = 'grabando'`: el micrófono
 *      quedaba ABIERTO con el aviso rojo en pantalla y ningún dedo encima;
 *   3. a partir de ahí `empezar()` ya no volvía a entrar
 *      (`if (fase !== 'inactiva') return;`), así que el micrófono se quedaba
 *      muerto para el resto de la vida de la pantalla.
 *
 * La única salida era la papelera, que descarta. De ahí «no se puede enviar la
 * nota de voz».
 *
 * =============================================================================
 * LA MÁQUINA DE ESTADOS, EXPLÍCITA
 * =============================================================================
 *
 *   inactiva ──pulsar──▶ permiso ──▶ grabando ──detener──▶ guardando ──▶ lista
 *      ▲                    │            │                                 │
 *      │                    ▼            ▼                              enviar
 *      │  (permiso denegado / cancelar / demasiado corta)                   │
 *      │                                                                    ▼
 *      ├──────────────── eliminar ◀── fallida ◀──(no)── enviando ──(sí)──▶ éxito
 *
 * NADA SE ENVÍA SOLO. Enviar es un toque aparte, sobre una nota que ya se ha
 * podido escuchar. Eso es lo que rompe la dependencia entre «terminar de
 * hablar» y «mandar», que era el origen del fallo: si el envío falla, la
 * grabación SIGUE AQUÍ y se puede reintentar sin volver a hablar.
 *
 * SE REUTILIZA `expo-audio`, que la aplicación ya trae para reproducir, y
 * `lib/permisos.ts` para los cinco estados reales de un permiso. LAS REGLAS DE
 * QUÉ HACER CON LO GRABADO siguen en `lib/notaDeVoz.ts`, que es código puro y
 * tiene pruebas.
 */

/** En qué punto está la nota de voz. */
export type FaseDeNotaDeVoz =
  /** No hay nada en marcha. El micrófono espera un toque. */
  | 'inactiva'
  /** Esperando la respuesta del sistema al permiso. */
  | 'permiso'
  /** El micrófono está abierto. */
  | 'grabando'
  /** Se pulsó detener y se está cerrando el fichero. */
  | 'guardando'
  /** Hay una nota grabada: se puede escuchar, eliminar o enviar. */
  | 'lista'
  /** Subiendo y guardando. No se admite ninguna acción. */
  | 'enviando'
  /** El envío falló. LA GRABACIÓN SIGUE AQUÍ, con su botón de reintentar. */
  | 'fallida';

export type AvisoDeGrabadora = {
  titulo: string;
  cuerpo: string;
  /** Cuando la única salida son los ajustes del teléfono. */
  accion?: { texto: string; alPulsar: () => void };
};

type Opciones = {
  /**
   * Sube la nota y crea el mensaje. Devuelve si el SERVIDOR lo confirmó.
   *
   * Es la frontera entera entre esta máquina y el chat, y devuelve un booleano
   * a propósito: sin él, un fallo de red dejaría la nota como enviada y quien
   * habló se quedaría sin saberlo. `true` es lo único que suelta la grabación.
   */
  alEnviar: (
    nota: AdjuntoElegido,
    avisarProgreso: (ratio: number) => void,
  ) => Promise<boolean>;
  /** Algo que hay que contarle a quien está mirando. */
  alAvisar: (aviso: AvisoDeGrabadora) => void;
};

/**
 * Extensiones de audio que sabemos nombrar. Es la validación de FORMATO: lo que
 * viaja al backend es la extensión y el tipo de contenido, y el bucket
 * `message-media` sólo admite `audio/*` (ver `services/messageMedia.ts`).
 */
const EXTENSIONES_DE_AUDIO = ['m4a', 'mp4', 'aac', 'caf', 'wav', '3gp', 'webm'];

/** Cómo se llama y qué tipo tiene el fichero que ha escrito el grabador. */
function describirFichero(uri: string): { nombre: string; tipo: string } {
  const bruta = uri.split('?')[0]?.split('.').pop()?.toLowerCase() ?? '';
  // Sin extensión reconocible se usa la del preset `HIGH_QUALITY`, que es lo
  // que de verdad escribe en las dos plataformas. `bin` haría que ningún
  // reproductor supiera qué decodificador abrir.
  const ext = EXTENSIONES_DE_AUDIO.includes(bruta) ? bruta : 'm4a';
  const tipo = ext === 'm4a' || ext === 'mp4' ? 'audio/mp4' : `audio/${ext}`;
  return { nombre: `nota-de-voz.${ext}`, tipo };
}

/**
 * Borra del teléfono el fichero de una grabación que ya no hace falta.
 *
 * El grabador escribe en la caché de la aplicación y nadie lo recogía: cada
 * nota cancelada, eliminada o ya enviada dejaba su `.m4a` ahí hasta que el
 * sistema decidiera limpiar. Es la misma llamada que ya usa
 * `services/storage.ts` para sus copias temporales (`deleteAsync` de la API
 * antigua, importada aquí dentro para que no entre en el paquete web).
 *
 * NUNCA LANZA. Si no se puede borrar, la caché la acaba limpiando el sistema:
 * no es motivo para estropear un envío que ya salió bien.
 */
async function borrarGrabacion(uri: string | null | undefined): Promise<void> {
  // En web la «ruta» es un `blob:` del navegador: no hay fichero que borrar.
  if (!uri || Platform.OS === 'web') return;
  try {
    const legacy = await import('expo-file-system/legacy');
    await legacy.deleteAsync(uri, { idempotent: true });
  } catch {
    /* Se queda en la caché. No es un fallo que haya que contarle a nadie. */
  }
}

/**
 * El preset de siempre, con la MEDICIÓN encendida.
 *
 * `isMeteringEnabled` hace que el grabador informe del nivel del micrófono en
 * cada lectura de estado. Es lo que permite pintar una onda que responde a la
 * voz DE VERDAD mientras se graba, en vez de una animación que se movería
 * igual con el micrófono tapado. No cambia el formato ni el fichero.
 *
 * Fuera del hook para que sea siempre el mismo objeto: unas opciones nuevas en
 * cada render harían que `useAudioRecorder` creara otro grabador nativo.
 */
const OPCIONES_DE_GRABACION = { ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true };

export function useGrabadoraDeVoz({ alEnviar, alAvisar }: Opciones) {
  const { t } = useTranslation();

  /*
    `HIGH_QUALITY` y no `LOW_QUALITY`, aunque una nota de voz no necesite calidad
    de estudio. El motivo no es la calidad sino el FORMATO: el preset bajo cambia
    Android a `.3gp` con AMR de banda estrecha —un contenedor distinto y una voz
    claramente peor— mientras que el alto da `.m4a` con AAC en las dos
    plataformas. Un solo formato es un solo camino que probar, una sola extensión
    que mandar al backend y un solo decodificador al otro lado.
  */
  const grabador = useAudioRecorder(OPCIONES_DE_GRABACION);

  const [fase, setFase] = useState<FaseDeNotaDeVoz>('inactiva');
  /** Milisegundos grabados. Se actualiza solo mientras el micrófono está abierto. */
  const [milisegundos, setMilisegundos] = useState(0);
  /**
   * El nivel del micrófono (0–1) en la última lectura, o `null` si esta
   * plataforma no mide. `null` NO es silencio: es «no se sabe», y quien pinta
   * la onda lo usa para no inventarse una señal.
   */
  const [nivel, setNivel] = useState<number | null>(null);
  /** La nota terminada, desde que se detiene hasta que se envía o se elimina. */
  const [nota, setNota] = useState<AdjuntoElegido | null>(null);
  /** De 0 a 1 mientras se sube. */
  const [progreso, setProgreso] = useState(0);

  /*
    Que hay que abandonar lo que se está preparando, en una referencia.

    Tiene que poder leerse DENTRO de `empezar()`, que es asíncrono y espera a
    cuatro llamadas nativas seguidas: si viviera en el estado, el valor que
    leería sería el del render en el que se creó la función —o sea, el de antes
    de cancelar— y el micrófono se abriría igual, sin nadie delante. Es
    exactamente el fallo que dejaba la grabadora colgada.
  */
  const abandonar = useRef(false);
  /*
    Que el diálogo de permiso del SISTEMA está en pantalla ahora mismo.

    Mientras se enseña, la aplicación deja de estar «activa» —`inactive` en iOS,
    `background` en Android, porque el diálogo es otra actividad— y vuelve en
    cuanto se contesta. Ese parpadeo se leía como «la persona se ha ido» y
    marcaba `abandonar`: la PRIMERA vez que alguien concedía el micrófono, la
    grabación se abortaba sin decir nada y había que pulsar otra vez sin saber
    por qué. Con esto, contestar al diálogo no cuenta como irse.
  */
  const preguntando = useRef(false);
  /* Para no dejar el micrófono abierto si la pantalla se cierra a media nota. */
  const montado = useRef(true);
  useEffect(() => {
    montado.current = true;
    return () => {
      montado.current = false;
    };
  }, []);

  /*
    Los borrados de ficheros en vuelo, en fila.

    En iOS el grabador escribe SIEMPRE en la misma ruta mientras viva la
    pantalla (solo estrena fichero si se le pasan opciones al preparar). Un
    borrado que aterrizara después de empezar la nota siguiente se llevaría el
    fichero que se está escribiendo. `empezar` espera a esta fila antes de
    preparar el grabador, así que el orden está garantizado y no depende de
    quién sea más rápido.
  */
  const limpieza = useRef<Promise<void>>(Promise.resolve());
  const tirarFichero = useCallback((uri: string | null | undefined) => {
    limpieza.current = limpieza.current.then(() => borrarGrabacion(uri));
    return limpieza.current;
  }, []);

  const grabando = fase === 'grabando';
  /** Hay algo en marcha: el redactor cede su sitio a la barra de voz. */
  const ocupada = fase !== 'inactiva';
  const segundos = grabando ? milisegundos / 1000 : nota?.durationS ?? 0;

  /*
    EL CONTADOR ES NUESTRO, Y SOLO EXISTE MIENTRAS SE GRABA.

    Antes esto era `useAudioRecorderState(grabador, 200)`, de `expo-audio`, y ahí
    estaba media causa de que salir del chat reventara la aplicación. Ese hook
    monta un `setInterval` que llama a `recorder.getStatus()` —una llamada al
    objeto NATIVO— **cada 200 ms, se esté grabando o no**. Es decir: cada chat
    abierto tenía un sondeo permanente contra el micrófono sin motivo.

    Ahora el intervalo solo existe cuando `fase === 'grabando'`, que es el 0,1 %
    del tiempo. Cuando no se graba, este hook NO TOCA NADA NATIVO.

    Los 200 ms se conservan: con el medio segundo que traía por defecto, el reloj
    de «0:03» daba saltos perceptibles mientras alguien habla mirándolo.

    SE LEE `getStatus().durationMillis` Y NO `currentTime`. En `expo-audio`
    1.1.1 `currentTime` solo es la duración en iOS; en Android el módulo nativo
    devuelve ahí el INSTANTE en que empezó la grabación (`startTime`, la hora
    del reloj en milisegundos). Con eso el contador marcaba un número absurdo,
    `llegoAlTope` daba verdadero en el primer tic y la nota se paraba sola a los
    200 ms diciendo que duraba cinco minutos. `durationMillis` es lo que
    `useAudioRecorderState` leía antes, y significa lo mismo en las dos
    plataformas y en web.
  */
  useEffect(() => {
    if (fase !== 'grabando') return;
    // Cada grabacion empieza sin nivel: hasta la primera lectura no se sabe
    // si esta plataforma mide.
    setNivel(null);
    const reloj = setInterval(() => {
      try {
        // UNA lectura nativa por tic, de la que salen el reloj y el nivel.
        const estado = grabador.getStatus();
        setMilisegundos(estado.durationMillis ?? 0);
        setNivel(nivelDeVoz(estado.metering));
      } catch {
        /* El objeto nativo ya no está. Se deja el último valor leído. */
      }
    }, 200);
    return () => clearInterval(reloj);
  }, [fase, grabador]);

  /** Cierra el micrófono y devuelve la sesión de audio a reproducir. */
  const cerrar = useCallback(async () => {
    try {
      await grabador.stop();
    } catch {
      /*
        Parar dos veces no es un error, y tampoco lo es parar algo que ya no
        existe: si la pantalla se cerró mientras esto estaba a medias,
        `expo-audio` ya liberó el objeto nativo y `stop()` lanza. En los dos
        casos el micrófono acaba cerrado, que es lo único que importa aquí.
      */
    }
    // Siempre, incluso si `stop` falló: dejar la sesión en modo grabación baja
    // el volumen de todo lo demás en iOS hasta que se cierre la aplicación.
    await permitirGrabar(false);
  }, [grabador]);

  /**
   * Empieza a grabar. LO DISPARA UN TOQUE, no mantener pulsado.
   *
   * El permiso se pide AQUÍ y no al abrir el chat: pedirlo sin contexto es lo
   * que hace que se rechace, y en iOS un rechazo no tiene vuelta atrás dentro
   * de la aplicación.
   *
   * LAS DOS COMPROBACIONES DE `abandonar` NO SON DEFENSIVAS, SON EL ARREGLO.
   * Entre este toque y el micrófono abierto hay cuatro llamadas nativas
   * esperadas, y en ese hueco caben perfectamente un «cancelar», un salir de la
   * pantalla o un paso a segundo plano. Sin ellas, el micrófono se abría
   * DESPUÉS de que nadie lo estuviera esperando y ya no se podía cerrar.
   */
  const empezar = useCallback(async () => {
    if (fase !== 'inactiva') return;
    abandonar.current = false;
    setMilisegundos(0);
    setProgreso(0);
    setNota(null);
    setFase('permiso');

    /*
      PEDIR EL PERMISO TAMBIÉN PUEDE FALLAR, y antes estaba fuera de cualquier
      `try`: si la llamada nativa lanzaba, la fase se quedaba en «permiso» para
      siempre —una rueda girando donde iba el micrófono— y como `empezar` solo
      entra desde «inactiva», ya no se podía grabar hasta salir del chat.
    */
    let permiso: EstadoDePermiso;
    preguntando.current = true;
    try {
      permiso = await pedirPermiso('microfono');
    } catch {
      setFase('inactiva');
      alAvisar({
        titulo: t('chat.voiceStartFailedTitle'),
        cuerpo: t('chat.voiceStartFailedBody'),
      });
      return;
    } finally {
      preguntando.current = false;
    }

    if (permiso !== 'concedido' && permiso !== 'limitado') {
      setFase('inactiva');
      /*
        `textoDePermiso` sigue decidiendo SI la única salida son los ajustes
        (`vaAAjustes`). Lo que se LEE sale del diccionario: sus textos están en
        español a mano y hablan de vídeo mudo; aquí lo que se pierde es la nota
        entera, y decirlo con precisión es lo que hace que se entienda.
      */
      const texto = {
        ...textoDePermiso('microfono', permiso),
        accion: t('chat.voiceOpenSettings'),
      };
      alAvisar({
        titulo: texto.vaAAjustes
          ? t('chat.voiceMicBlockedTitle')
          : t('chat.voiceMicNeededTitle'),
        cuerpo: texto.vaAAjustes
          ? t('chat.voiceMicBlockedBody')
          : t('chat.voiceMicNeededBody'),
        accion: texto.vaAAjustes
          ? { texto: texto.accion, alPulsar: abrirAjustes }
          : undefined,
      });
      return;
    }

    if (abandonar.current || !montado.current) {
      // Se canceló —o se salió de la pantalla— mientras el sistema preguntaba.
      // No se abre nada.
      setFase('inactiva');
      return;
    }

    try {
      // Si queda un fichero anterior borrándose, primero termina: en iOS la
      // ruta es la misma y el borrado se llevaría la nota nueva. Ver `limpieza`.
      await limpieza.current;
      // La sesión de audio, ANTES de preparar: en iOS `prepareToRecordAsync`
      // falla si la categoría no admite grabar.
      await permitirGrabar(true);
      await grabador.prepareToRecordAsync();
      if (abandonar.current || !montado.current) {
        await cerrar();
        setFase('inactiva');
        return;
      }
      grabador.record();
      setFase('grabando');
    } catch {
      /*
        `cerrar()` Y NO SOLO DEVOLVER LA SESIÓN. Si lo que falló fue `record()`
        —el micrófono lo tiene una llamada—, el grabador ya estaba PREPARADO y
        así se quedaba: el siguiente intento reventaba con «AudioRecorder has
        already been prepared» y el micrófono no volvía a funcionar hasta salir
        del chat. `stop()` es la única forma de deshacer una preparación, y
        `cerrar` ya tolera que no hubiera nada que parar.
      */
      await cerrar();
      setFase('inactiva');
      alAvisar({
        titulo: t('chat.voiceStartFailedTitle'),
        cuerpo: t('chat.voiceStartFailedBody'),
      });
    }
  }, [fase, grabador, alAvisar, cerrar, t]);

  /**
   * Cierra el micrófono y decide qué queda: una nota en la previa, o nada.
   *
   * `decidirDesenlace` es la misma función pura de siempre (`lib/notaDeVoz.ts`,
   * con pruebas): cancelar gana sobre todo lo demás, y una grabación por debajo
   * del mínimo se tira Y SE EXPLICA, porque quien la hizo no sabe por qué no ha
   * pasado nada.
   */
  const parar = useCallback(
    async (cancelada: boolean) => {
      setFase('guardando');
      // Del nativo con red debajo: esto es asíncrono y la pantalla puede
      // cerrarse en mitad. Si el objeto ya no está, se usa lo último que contó
      // nuestro reloj, que para decidir la duración vale igual.
      let ms = milisegundos;
      try {
        // `durationMillis` y no `currentTime`: ver el comentario del contador.
        // Se lee ANTES de parar, que es cuando todavía vale algo.
        const medido = grabador.getStatus().durationMillis;
        if (medido > 0) ms = medido;
      } catch {
        /* Liberado. Nos quedamos con lo contado. */
      }
      await cerrar();

      let uri: string | null = null;
      try {
        uri = grabador.uri;
      } catch {
        /* Liberado: no hay fichero que mandar y se avisa más abajo. */
      }

      const desenlace = decidirDesenlace({ ms, cancelada });
      setMilisegundos(0);

      if (desenlace === 'descartar') {
        // Lo cancelado no se va a mandar nunca: su fichero sobra. Se espera al
        // borrado ANTES de volver a «inactiva», que es lo que deja grabar otra.
        await tirarFichero(uri);
        setNota(null);
        setFase('inactiva');
        return;
      }
      if (desenlace === 'demasiado-corta') {
        await tirarFichero(uri);
        setNota(null);
        setFase('inactiva');
        alAvisar({
          titulo: t('chat.voiceTooShortTitle'),
          // El texto ya NO habla de dejar el dedo puesto: la interacción es
          // pulsar, hablar y pulsar «Detener». Un texto que explica un gesto
          // que ya no existe deja a quien lo lee peor que sin texto.
          cuerpo: t('chat.voiceTooShortBody'),
        });
        return;
      }
      if (!uri) {
        setNota(null);
        setFase('inactiva');
        alAvisar({
          titulo: t('chat.voiceSaveFailedTitle'),
          cuerpo: t('chat.voiceSaveFailedBody'),
        });
        return;
      }

      const { nombre, tipo } = describirFichero(uri);
      setNota({
        uri,
        kind: 'audio',
        // El nombre no se enseña —una nota de voz se identifica por su duración,
        // no por su fichero— pero la extensión decide el tipo con el que se sube.
        name: nombre,
        mimeType: tipo,
        // EL TAMAÑO LO MIDE `subirAdjunto` leyendo el fichero de verdad, y ahí
        // se rechaza lo vacío y lo que pase de `MAX_ADJUNTO_BYTES`. Informarlo
        // aquí sería adivinarlo.
        bytes: null,
        width: null,
        height: null,
        // Nunca por encima del tope: el backend aplica el mismo, y pasarse por
        // una décima tiraría la subida entera después de hacerla.
        durationS: duracionEnSegundos(Math.min(ms, MAX_DURACION_S * 1000)),
      });
      setFase('lista');
    },
    [milisegundos, grabador, cerrar, alAvisar, tirarFichero, t],
  );

  /** Deja de grabar Y CONSERVA lo grabado: pasa a la previa. */
  const detener = useCallback(async () => {
    if (fase !== 'grabando') return;
    await parar(false);
  }, [fase, parar]);

  /**
   * Tira la grabación. HAY QUE PODER ARREPENTIRSE ANTES DE MANDAR.
   *
   * Vale también mientras se pide el permiso: ahí todavía no hay micrófono
   * abierto que cerrar, sólo una secuencia en vuelo a la que hay que decirle
   * que ya no la espera nadie.
   */
  const cancelar = useCallback(async () => {
    if (fase === 'permiso') {
      abandonar.current = true;
      return;
    }
    if (fase !== 'grabando') return;
    abandonar.current = true;
    await parar(true);
  }, [fase, parar]);

  /** Tira la nota que estaba en la previa —o la que falló al enviarse—. */
  const eliminar = useCallback(() => {
    if (fase !== 'lista' && fase !== 'fallida') return;
    // El fichero se va con la nota. No se espera: la papelera responde en el
    // acto, y `empezar` ya aguarda a la fila de borrados antes de grabar otra.
    void tirarFichero(nota?.uri);
    setNota(null);
    setProgreso(0);
    setMilisegundos(0);
    setFase('inactiva');
  }, [fase, nota, tirarFichero]);

  /**
   * Sube la nota y crea el mensaje. Es también el «reintentar» de un fallo.
   *
   * SOLO SE ENTRA DESDE `lista` O `fallida`, y esa guarda es lo que garantiza
   * que el mensaje se inserta EXACTAMENTE UNA VEZ: mientras vale `'enviando'`,
   * volver a pulsar no hace nada, así que no hay forma de lanzar dos subidas de
   * la misma grabación. (La otra mitad del problema —que el mensaje llegue a la
   * vez por la respuesta del POST y por Realtime— la resuelve `fusionar` en
   * `lib/mensajesEnVivo.ts`.)
   *
   * UN FALLO NO BORRA NADA. Se vuelve a `'fallida'` con la nota intacta: lo
   * que cuesta rehacer es haberla dicho, no pulsar enviar.
   */
  const enviar = useCallback(async () => {
    if (fase !== 'lista' && fase !== 'fallida') return;
    const pendiente = nota;
    if (!pendiente) return;

    setProgreso(0);
    setFase('enviando');

    let confirmado = false;
    try {
      confirmado = await alEnviar(pendiente, (ratio) => {
        if (montado.current) setProgreso(Math.min(1, Math.max(0, ratio)));
      });
    } catch {
      confirmado = false;
    }

    // Ya está en el servidor: la copia del teléfono sobra, siga o no la
    // pantalla en pie. SOLO con confirmación: tras un fallo el fichero es lo
    // único que permite reintentar sin volver a hablar.
    if (confirmado) await tirarFichero(pendiente.uri);

    if (!montado.current) return;
    if (confirmado) {
      setNota(null);
      setProgreso(0);
      setFase('inactiva');
    } else {
      setFase('fallida');
    }
  }, [fase, nota, alEnviar, tirarFichero]);

  /*
    Al llegar al tope se PARA SOLA y queda en la previa.

    Es mejor que dejar grabar y rechazarlo después: quien está hablando ve que
    se ha detenido y decide si lo manda, en vez de descubrir al soltar que ha
    perdido cinco minutos. El backend aplica el mismo tope, así que sin esto la
    subida entera se haría para nada.
  */
  useEffect(() => {
    if (fase !== 'grabando') return;
    if (llegoAlTope(milisegundos)) void detener();
  }, [fase, milisegundos, detener]);

  /*
    LA APLICACION SE VA A SEGUNDO PLANO: SE CIERRA EL MICROFONO Y SE CONSERVA
    LO DICHO.

    Android puede matar la grabación sin avisar y en iOS una llamada interrumpe
    la sesión de audio; en los dos casos seguir «grabando» en pantalla sería
    mentir. Se para y la nota pasa a la previa: perder lo que alguien acaba de
    decir por atender una llamada es el peor momento posible para perderlo.

    Va por referencia y no por dependencia: `detener` cambia de identidad en
    cada tic del reloj (200 ms), y suscribirse y desuscribirse de `AppState`
    cinco veces por segundo mientras se graba es justo el sondeo que este hook
    se quitó de encima.
  */
  const alIrseAlFondo = useRef<() => void>(() => {});
  alIrseAlFondo.current = () => {
    // Con el diálogo de permiso del sistema delante NO cuenta como irse: ver
    // `preguntando`. Sin esta guarda, conceder el permiso abortaba la grabación.
    if (fase === 'permiso' && !preguntando.current) abandonar.current = true;
    if (fase === 'grabando') void detener();
  };
  useEffect(() => {
    if (fase !== 'grabando' && fase !== 'permiso') return;
    const suscripcion = AppState.addEventListener('change', (estado) => {
      if (estado !== 'active') alIrseAlFondo.current();
    });
    return () => suscripcion.remove();
  }, [fase]);

  /*
    LA PANTALLA PIERDE EL FOCO SIN DESMONTARSE: SE CIERRA EL MICRÓFONO Y SE
    CONSERVA LO DICHO.

    Tocar la cabecera abre el perfil ENCIMA del chat, y el chat sigue montado
    debajo: la grabación seguía corriendo con el micrófono abierto en una
    pantalla que nadie miraba, sin reloj, sin «Detener» y sin forma de saberlo.
    Es el mismo trato que al irse a segundo plano: se para y la nota queda en
    la previa, esperando a la vuelta.

    EN EL DESMONTAJE ESTO NO HACE NADA, a propósito. `useFocusEffect` también
    ejecuta su limpieza al desmontar, y ahí el grabador ya está liberado (ver
    el comentario siguiente): `montado` —cuya limpieza se declaró antes y por
    tanto corre antes— lo distingue, y de esa salida se encarga la limpieza de
    abajo sin tocar nada nativo.

    Por referencia, igual que `alIrseAlFondo`: la función cambia en cada tic.
  */
  const alPerderElFoco = useRef<() => void>(() => {});
  alPerderElFoco.current = () => {
    if (!montado.current) return;
    if (fase === 'permiso') abandonar.current = true;
    if (fase === 'grabando') void detener();
  };
  useFocusEffect(
    useCallback(
      () => () => {
        alPerderElFoco.current();
      },
      [],
    ),
  );

  /*
    AQUI ESTABA EL FALLO QUE CERRABA LA APLICACION AL SALIR DEL CHAT.

    Esto decia `if (grabador.isRecording) void cerrar()`, y `isRecording` es una
    propiedad del objeto NATIVO. El problema es CUANDO se leia.

    `useAudioRecorder` se apoya en `useReleasingSharedObject`, cuya limpieza
    llama a `release()` al desmontar. React ejecuta las limpiezas en el ORDEN EN
    QUE SE DECLARARON los efectos, y `useAudioRecorder` es la primera linea de
    este hook: para cuando corria esta limpieza —la ultima—, el objeto ya estaba
    liberado. Leer cualquier cosa de el lanza «Cannot use shared object that was
    already released», y como el puente pasa entonces el ID en vez del objeto, en
    Android sale ademas «The 1st argument cannot be cast to type
    expo.modules.audio.AudioRecorder (received class java.lang.Integer)».

    Y saltaba SIEMPRE al salir del chat, se hubiera grabado o no: bastaba con
    leer la propiedad.

    LA REGLA, entonces: EN EL DESMONTAJE NO SE TOCA NADA NATIVO. Si hacia falta
    saber si se estaba grabando, se guarda por nuestra cuenta —abajo— y no se le
    pregunta a un objeto que quizas ya no existe.

    Y NO HACE FALTA PARAR EL GRABADOR. `release()` cierra el microfono y libera
    el recurso: eso ya lo hace `expo-audio`. Lo unico que queda por deshacer es
    la SESION DE AUDIO, que no es del grabador sino del proceso entero, y que si
    se queda en modo grabacion baja el volumen de toda la aplicacion en iOS.
  */
  const grabandoAhora = useRef(false);
  useEffect(() => {
    grabandoAhora.current = fase === 'grabando';
  }, [fase]);

  useEffect(() => {
    return () => {
      // Que una secuencia de arranque en vuelo no abra el microfono detras de
      // una pantalla que ya no existe.
      abandonar.current = true;
      if (grabandoAhora.current) void permitirGrabar(false);
    };
  }, []);

  return {
    fase,
    grabando,
    ocupada,
    /** Segundos: los grabados mientras se graba, los de la nota después. */
    segundos,
    /** De 0 a 1 sobre el máximo. Para la barra que avisa de que se acaba. */
    avance: Math.min(1, (grabando ? milisegundos / 1000 : 0) / MAX_DURACION_S),
    /** La nota terminada, mientras existe. */
    nota,
    /** De 0 a 1 mientras se sube. */
    progreso,
    /** El nivel del micrófono (0–1) mientras se graba; `null` si no se mide. */
    nivel,
    empezar,
    detener,
    cancelar,
    eliminar,
    enviar,
  };
}
