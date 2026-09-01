import { useCallback, useEffect, useRef, useState } from 'react';
import { RecordingPresets, useAudioRecorder, useAudioRecorderState } from 'expo-audio';

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
 * SE REUTILIZA `expo-audio`, que la aplicación ya trae para reproducir. No se
 * añade ninguna librería de grabación: la que hay hace exactamente esto y una
 * segunda sería otra dependencia nativa que mantener, otra compilación que
 * romper y otro sitio donde el permiso de micrófono se pide distinto.
 *
 * Y SE REUTILIZA `lib/permisos.ts`, que a su vez se apoya en
 * `lib/estadoDePermiso.ts` —el módulo con pruebas que distingue los cinco
 * estados de un permiso—. Eso es lo que permite que un «no» se explique en vez
 * de dejar un botón mudo: si el sistema ya no va a preguntar más, se lleva a la
 * persona a los ajustes en lugar de pedirlo otra vez y no hacer nada.
 *
 * LAS REGLAS DE QUÉ HACER CON LO GRABADO NO ESTÁN AQUÍ, están en
 * `lib/notaDeVoz.ts`, que es código puro y tiene pruebas. Aquí solo queda lo
 * que necesita un teléfono de verdad: pedir permiso, arrancar el micrófono y
 * escribir el fichero.
 */

/** En qué punto está la grabación. */
export type EstadoDeGrabadora =
  /** Parada. */
  | 'inactiva'
  /** Esperando la respuesta del sistema al permiso. */
  | 'permiso'
  /** El micrófono está abierto. */
  | 'grabando'
  /** Soltó y se está cerrando el fichero. */
  | 'guardando';

export type AvisoDeGrabadora = {
  titulo: string;
  cuerpo: string;
  /** Cuando la única salida son los ajustes del teléfono. */
  accion?: { texto: string; alPulsar: () => void };
};

type Opciones = {
  /** La nota está lista para mandarse. */
  alTerminar: (nota: AdjuntoElegido) => void;
  /** Algo que hay que contarle a quien está mirando. */
  alAvisar: (aviso: AvisoDeGrabadora) => void;
};

export function useGrabadoraDeVoz({ alTerminar, alAvisar }: Opciones) {
  /*
    `HIGH_QUALITY` y no `LOW_QUALITY`, aunque una nota de voz no necesite calidad
    de estudio. El motivo no es la calidad sino el FORMATO: el preset bajo cambia
    Android a `.3gp` con AMR de banda estrecha —un contenedor distinto y una voz
    claramente peor— mientras que el alto da `.m4a` con AAC en las dos
    plataformas. Un solo formato es un solo camino que probar, una sola extensión
    que mandar al backend y un solo decodificador al otro lado. Lo que se ahorra
    con el preset bajo son unos cientos de kilobytes; lo que cuesta es que la
    nota de un Android suene distinta a la de un iPhone.
  */
  const grabador = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  /*
    200 ms: es lo que tarda el contador en verse fluido sin repintar de más.
    Con el medio segundo que trae por defecto, el reloj de «0:03» daba saltos
    perceptibles mientras alguien habla mirándolo.
  */
  const estado = useAudioRecorderState(grabador, 200);

  const [fase, setFase] = useState<EstadoDeGrabadora>('inactiva');

  /*
    Que se ha cancelado, en una referencia y no en el estado.

    Tiene que poder leerse DENTRO de `soltar()`, que es asíncrono: si viviera en
    el estado, el valor que leería sería el del render en el que se creó la
    función, o sea el de antes de cancelar, y la nota se mandaría igual. Es el
    fallo clásico de mezclar estado de React con una secuencia asíncrona.
  */
  const cancelada = useRef(false);
  /* Para no dejar el micrófono abierto si la pantalla se cierra a media nota. */
  const montado = useRef(true);
  useEffect(() => {
    montado.current = true;
    return () => {
      montado.current = false;
    };
  }, []);

  const grabando = fase === 'grabando';
  const segundos = grabando ? (estado.durationMillis ?? 0) / 1000 : 0;

  /** Cierra el micrófono y devuelve la sesión de audio a reproducir. */
  const cerrar = useCallback(async () => {
    try {
      await grabador.stop();
    } catch {
      /* Ya estaba parado. Parar dos veces no es un error. */
    }
    // Siempre, incluso si `stop` falló: dejar la sesión en modo grabación baja
    // el volumen de todo lo demás en iOS hasta que se cierre la aplicación.
    await permitirGrabar(false);
  }, [grabador]);

  /**
   * Empieza a grabar. Lo dispara MANTENER PULSADO, nunca un toque.
   *
   * El permiso se pide AQUÍ y no al abrir el chat: pedirlo sin contexto es lo
   * que hace que se rechace, y en iOS un rechazo no tiene vuelta atrás dentro
   * de la aplicación.
   */
  const empezar = useCallback(async () => {
    if (fase !== 'inactiva') return;
    cancelada.current = false;
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

    try {
      // La sesión de audio, ANTES de preparar: en iOS `prepareToRecordAsync`
      // falla si la categoría no admite grabar.
      await permitirGrabar(true);
      await grabador.prepareToRecordAsync();
      grabador.record();
      if (!montado.current) {
        // La pantalla se cerró mientras se pedía el permiso. No se deja el
        // micrófono abierto detrás.
        await cerrar();
        return;
      }
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

  /** Suelta el dedo: para, y decide si se manda o se tira. */
  const soltar = useCallback(async () => {
    if (fase !== 'grabando') {
      // Soltar sin haber llegado a grabar —un toque, o un permiso denegado— no
      // hace nada. Es lo que impide que un roce mande una nota vacía.
      return;
    }
    setFase('guardando');
    const ms = grabador.currentTime ? grabador.currentTime * 1000 : estado.durationMillis ?? 0;
    await cerrar();

    const uri = grabador.uri;
    const desenlace = decidirDesenlace({ ms, cancelada: cancelada.current });
    setFase('inactiva');

    if (desenlace === 'descartar') return;
    if (desenlace === 'demasiado-corta') {
      alAvisar({
        titulo: 'Muy corta',
        cuerpo: 'Mantén pulsado el micrófono mientras hablas y suelta al terminar.',
      });
      return;
    }
    if (!uri) {
      alAvisar({
        titulo: 'No se pudo guardar',
        cuerpo: 'La grabación no llegó a escribirse. Inténtalo otra vez.',
      });
      return;
    }

    alTerminar({
      uri,
      kind: 'audio',
      // El nombre no se enseña —una nota de voz se identifica por su duración,
      // no por su fichero— pero la extensión decide el tipo con el que se sube.
      name: 'nota-de-voz.m4a',
      mimeType: 'audio/mp4',
      bytes: null,
      width: null,
      height: null,
      durationS: duracionEnSegundos(ms),
    });
  }, [fase, grabador, estado.durationMillis, cerrar, alTerminar, alAvisar]);

  /**
   * Tira la grabación. HAY QUE PODER ARREPENTIRSE ANTES DE MANDAR.
   *
   * Marca primero y para después: `soltar()` lee la marca, así que el orden es
   * lo que decide si la nota se manda. Al revés, cancelar justo al soltar
   * mandaría la nota igual.
   */
  const cancelar = useCallback(async () => {
    if (fase !== 'grabando') return;
    cancelada.current = true;
    await soltar();
  }, [fase, soltar]);

  /*
    Al llegar al tope se PARA SOLA y se manda lo grabado.

    Es mejor que dejar grabar y rechazarlo después: quien está hablando ve que
    se ha detenido y decide si lo manda, en vez de descubrir al soltar que ha
    perdido cinco minutos. El backend aplica el mismo tope, así que sin esto la
    subida entera se haría para nada.
  */
  useEffect(() => {
    if (fase !== 'grabando') return;
    if (llegoAlTope(estado.durationMillis ?? 0)) void soltar();
  }, [fase, estado.durationMillis, soltar]);

  /* Si la pantalla se cierra a media nota, el micrófono se cierra con ella. */
  useEffect(() => {
    return () => {
      if (grabador.isRecording) void cerrar();
    };
  }, [grabador, cerrar]);

  return {
    fase,
    grabando,
    /** Segundos grabados hasta ahora. Para el reloj. */
    segundos,
    /** De 0 a 1 sobre el máximo. Para la barra que avisa de que se acaba. */
    avance: Math.min(1, segundos / MAX_DURACION_S),
    empezar,
    soltar,
    cancelar,
  };
}
