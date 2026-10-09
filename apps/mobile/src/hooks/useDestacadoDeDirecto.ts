import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { describeError } from '@/lib/describeError';
import {
  claveDelFalloDeDestacado,
  crearRepaso,
  destacadoVacio,
  sinDestacado,
  type EstiloDeRotulo,
  type Repaso,
} from '@/live/destacado';
import { LiveRepository, type DestacadoDeEmision } from '@/repositories/LiveRepository';
import { ApiError } from '@/services/api';
import { avisosDeDestacado, type AvisosDeDestacado } from '@/services/directoEnVivo';

/**
 * Cada cuánto, como mucho, vuelve a preguntar este teléfono al recibir avisos.
 * Dos segundos no se notan en un rótulo y cortan cualquier chaparrón.
 */
const ESPERA_ENTRE_PREGUNTAS_MS = 2_000;

/** Si el aviso no pudo salir (el canal aún no estaba suscrito), un reintento. */
const REINTENTO_DEL_AVISO_MS = 1_500;

type Opciones = {
  emisionId: string;
  /** Solo hay algo destacado mientras la emisión está en vivo. */
  enDirecto: boolean;
  /** Un fallo, ya traducido, para la banda de avisos de la sala. */
  alFallar: (texto: string) => void;
};

export type DestacadoEnPantalla = {
  /** El servidor admite destacar. Sin esto no se enseña ninguna opción. */
  disponible: boolean;
  destacado: DestacadoDeEmision;
  /** Hay un gesto en vuelo: sus botones van deshabilitados. */
  ocupado: boolean;
  /** `true` si se hizo. El fallo ya se ha contado por `alFallar`. */
  fijar: (mensajeId: string) => Promise<boolean>;
  soltar: () => Promise<boolean>;
  ponerRotulo: (texto: string, estilo: EstiloDeRotulo) => Promise<boolean>;
  quitarRotulo: () => Promise<boolean>;
  /**
   * Algo cambió por otro camino —se ha escondido el mensaje fijado—: se vuelve
   * a preguntar y se avisa a los demás.
   */
  cambioPorFuera: () => void;
};

/**
 * Lo destacado de un directo, visto desde este teléfono.
 *
 * QUÉ HACE Y QUÉ NO. Pregunta al servidor qué mensaje está fijado y qué rótulo
 * hay, y manda los gestos de quien emite. NO decide nada: lo que se pinta es
 * siempre lo último que contestó el servidor, nunca lo que este teléfono cree
 * que acaba de hacer. Las reglas están en `live/destacado.ts`.
 *
 * CÓMO SE ENTERA DE LO QUE HACE QUIEN EMITE. Por un aviso de difusión sin
 * contenido, que solo sirve para volver a preguntar —con medida: ver
 * `crearRepaso`—. Si el aviso se pierde, se pregunta también al entrar, al
 * volver a primer plano y cuando el canal se recupera de una caída.
 *
 * TAMBIÉN SIN CUENTA. Quien mira sin haber entrado ve lo destacado igual: lo
 * está viendo en pantalla.
 */
export function useDestacadoDeDirecto({
  emisionId,
  enDirecto,
  alFallar,
}: Opciones): DestacadoEnPantalla {
  const { t } = useTranslation();

  const [disponible, setDisponible] = useState(false);
  const [destacado, setDestacado] = useState<DestacadoDeEmision>(destacadoVacio);
  const [ocupado, setOcupado] = useState(false);

  const enVuelo = useRef(false);
  const vigente = useRef(true);
  const avisos = useRef<AvisosDeDestacado | null>(null);
  const repaso = useRef<Repaso | null>(null);
  // Lo que cambia en cada render entra por referencia: el canal de avisos no
  // se puede volver a abrir cada vez que la pantalla se repinta.
  const ultimas = useRef({ alFallar, t });
  ultimas.current = { alFallar, t };

  useEffect(() => {
    vigente.current = true;
    return () => {
      vigente.current = false;
    };
  }, []);

  /** Una respuesta del servidor: es lo que se pinta. */
  const aplicar = useCallback((nuevo: DestacadoDeEmision) => {
    if (!vigente.current) return;
    setDisponible(true);
    setDestacado(nuevo);
  }, []);

  /** Pregunta y pinta. No rechaza nunca: es lo que espera `crearRepaso`. */
  const cargar = useCallback(async () => {
    if (!emisionId) return;
    try {
      aplicar(await LiveRepository.destacado(emisionId));
    } catch (error) {
      // Solo «aquí no se puede destacar» esconde la función. Un fallo de red
      // deja lo que ya se sabía: llegará otro aviso, o se volverá a entrar.
      if (!vigente.current) return;
      if (sinDestacado(error instanceof ApiError ? error : null)) setDisponible(false);
    }
  }, [aplicar, emisionId]);

  // Mientras hay directo: leer al entrar, y volver a leer cuando avisen.
  useEffect(() => {
    if (!enDirecto || !emisionId) return;

    const turno = crearRepaso({
      leer: cargar,
      esperaMs: ESPERA_ENTRE_PREGUNTAS_MS,
      programar: (fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
      ahora: () => Date.now(),
    });
    repaso.current = turno;
    turno.ahoraMismo();

    let seConectoAntes = false;
    const conexion = avisosDeDestacado(
      emisionId,
      () => turno.pedir(),
      () => {
        // Vuelve después de una caída: lo que se cambió entre medias no llegó.
        if (seConectoAntes) turno.pedir();
        seConectoAntes = true;
      },
    );
    avisos.current = conexion;

    // Al volver a primer plano: el teléfono pudo pasar minutos sin recibir nada.
    const alVolver = AppState.addEventListener('change', (estado) => {
      if (estado === 'active') turno.pedir();
    });

    return () => {
      alVolver.remove();
      avisos.current = null;
      conexion.cerrar();
      repaso.current = null;
      turno.destruir();
    };
  }, [cargar, emisionId, enDirecto]);

  // La emisión terminó: no queda nada destacado a la vista.
  useEffect(() => {
    if (enDirecto) return;
    setDestacado(destacadoVacio());
  }, [enDirecto]);

  const contarFallo = useCallback((error: unknown) => {
    const { alFallar: avisar, t: traducir } = ultimas.current;
    const clave = claveDelFalloDeDestacado(error instanceof ApiError ? error.code : null);
    avisar(
      clave
        ? traducir(clave as TranslationKey)
        : describeError(error, traducir('live.spotlightFailed')),
    );
  }, []);

  /** «Lo destacado cambió», a todos. Con un reintento si el canal no estaba. */
  const avisar = useCallback(() => {
    const emisor = avisos.current;
    if (!emisor || emisor.avisar()) return;
    setTimeout(() => {
      if (avisos.current === emisor) emisor.avisar();
    }, REINTENTO_DEL_AVISO_MS);
  }, []);

  /** Un gesto: se manda, se pinta LO QUE CONTESTA EL SERVIDOR y se avisa. */
  const gesto = useCallback(
    async (accion: () => Promise<DestacadoDeEmision>): Promise<boolean> => {
      // El freno de la doble pulsación, igual que en el escenario.
      if (enVuelo.current) return false;
      enVuelo.current = true;
      setOcupado(true);
      try {
        aplicar(await accion());
        avisar();
        return true;
      } catch (error) {
        contarFallo(error);
        // Puede que el estado haya cambiado por debajo (alguien lo escondió):
        // se vuelve a preguntar en vez de dejar en pantalla lo que ya no es.
        repaso.current?.pedir();
        return false;
      } finally {
        enVuelo.current = false;
        if (vigente.current) setOcupado(false);
      }
    },
    [aplicar, avisar, contarFallo],
  );

  const fijar = useCallback(
    (mensajeId: string) => gesto(() => LiveRepository.fijarMensaje(emisionId, mensajeId)),
    [emisionId, gesto],
  );
  const soltar = useCallback(
    () => gesto(() => LiveRepository.soltarMensaje(emisionId)),
    [emisionId, gesto],
  );
  const ponerRotulo = useCallback(
    (texto: string, estilo: EstiloDeRotulo) =>
      gesto(() => LiveRepository.ponerRotulo(emisionId, texto, estilo)),
    [emisionId, gesto],
  );
  const quitarRotulo = useCallback(
    () => gesto(() => LiveRepository.quitarRotulo(emisionId)),
    [emisionId, gesto],
  );

  const cambioPorFuera = useCallback(() => {
    repaso.current?.ahoraMismo();
    avisar();
  }, [avisar]);

  return {
    disponible: disponible && enDirecto,
    destacado,
    ocupado,
    fijar,
    soltar,
    ponerRotulo,
    quitarRotulo,
    cambioPorFuera,
  };
}
