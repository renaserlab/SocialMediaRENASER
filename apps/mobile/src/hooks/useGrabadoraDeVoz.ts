import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { RecordingPresets, useAudioRecorder } from 'expo-audio';

import { permitirGrabar } from '@/hooks/useBackgroundAudio';
import {
  decidirDesenlace,
  duracionEnSegundos,
  llegoAlTope,
  MAX_DURACION_S,
} from '@/lib/notaDeVoz';
import { abrirAjustes, pedirPermiso, textoDePermiso } from '@/lib/permisos';
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

export function useGrabadoraDeVoz({ alEnviar, alAvisar }: Opciones) {
  /*
    `HIGH_QUALITY` y no `LOW_QUALITY`, aunque una nota de voz no necesite calidad
    de estudio. El motivo no es la calidad sino el FORMATO: el preset bajo cambia
    Android a `.3gp` con AMR de banda estrecha —un contenedor distinto y una voz
    claramente peor— mientras que el alto da `.m4a` con AAC en las dos
    plataformas. Un solo formato es un solo camino que probar, una sola extensión
    que mandar al backend y un solo decodificador al otro lado.
  */
  const grabador = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  const [fase, setFase] = useState<FaseDeNotaDeVoz>('inactiva');
  /** Milisegundos grabados. Se actualiza solo mientras el micrófono está abierto. */
  const [milisegundos, setMilisegundos] = useState(0);
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
  /* Para no dejar el micrófono abierto si la pantalla se cierra a media nota. */
  const montado = useRef(true);
  useEffect(() => {
    montado.current = true;
    return () => {
      montado.current = false;
    };
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
  */
  useEffect(() => {
    if (fase !== 'grabando') return;
    const reloj = setInterval(() => {
      try {
        setMilisegundos((grabador.currentTime ?? 0) * 1000);
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

    const permiso = await pedirPermiso('microfono');
    if (permiso !== 'concedido' && permiso !== 'limitado') {
      setFase('inactiva');
      const texto = textoDePermiso('microfono', permiso);
      alAvisar({
        titulo: texto.titulo,
        // El texto genérico habla de vídeo mudo; aquí lo que se pierde es la
        // nota entera, y decirlo con precisión es lo que hace que se entienda.
        cuerpo:
          permiso === 'bloqueado'
            ? texto.cuerpo
            : 'Sin micrófono no se pueden grabar notas de voz. Puedes seguir ' +
              'escribiendo y mandando archivos con normalidad.',
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
      await permitirGrabar(false);
      setFase('inactiva');
      alAvisar({
        titulo: 'No se pudo grabar',
        cuerpo:
          'El micrófono no está disponible ahora mismo. Puede que lo esté ' +
          'usando otra aplicación, como una llamada.',
      });
    }
  }, [fase, grabador, alAvisar, cerrar]);

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
        if (grabador.currentTime) ms = grabador.currentTime * 1000;
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
        setNota(null);
        setFase('inactiva');
        return;
      }
      if (desenlace === 'demasiado-corta') {
        setNota(null);
        setFase('inactiva');
        alAvisar({
          titulo: 'Muy corta',
          // Ya NO dice «mantén pulsado»: la interacción es pulsar, hablar y
          // pulsar «Detener». Un texto que explica un gesto que ya no existe
          // deja a quien lo lee peor que sin texto.
          cuerpo: 'Pulsa el micrófono, habla y pulsa «Detener» cuando acabes.',
        });
        return;
      }
      if (!uri) {
        setNota(null);
        setFase('inactiva');
        alAvisar({
          titulo: 'No se pudo guardar',
          cuerpo: 'La grabación no llegó a escribirse. Inténtalo otra vez.',
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
    [milisegundos, grabador, cerrar, alAvisar],
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
    setNota(null);
    setProgreso(0);
    setMilisegundos(0);
    setFase('inactiva');
  }, [fase]);

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

    if (!montado.current) return;
    if (confirmado) {
      setNota(null);
      setProgreso(0);
      setFase('inactiva');
    } else {
      setFase('fallida');
    }
  }, [fase, nota, alEnviar]);

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
    if (fase === 'permiso') abandonar.current = true;
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
    empezar,
    detener,
    cancelar,
    eliminar,
    enviar,
  };
}
