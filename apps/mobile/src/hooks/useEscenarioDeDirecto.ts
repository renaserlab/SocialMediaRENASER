import { useCallback, useEffect, useRef, useState } from 'react';

import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { describeError } from '@/lib/describeError';
import {
  claveDelFalloDeEscenario,
  escenarioVacio,
  meTocaElAviso,
  pasoTrasLeer,
  type Escenario,
} from '@/live/escenario';
import type { SesionDeDirecto } from '@/live/maquinaDeDirecto';
import { LiveRepository, sinInvitados } from '@/repositories/LiveRepository';
import { ApiError } from '@/services/api';
import { avisosDelEscenario, type AvisosDelEscenario } from '@/services/directoEnVivo';
import { useAppStore } from '@/store/useAppStore';

/** Cada cuánto confirma con el servidor que sigue arriba quien está en pantalla. */
const REPASO_ESTANDO_ARRIBA_MS = 15_000;

type Opciones = {
  emisionId: string;
  /** Solo hay escenario mientras la emisión está en vivo. */
  enDirecto: boolean;
  /** Si esta persona gestiona la emisión (`can_manage`). */
  gestiono: boolean;
  /** A quién avisar cuando contesto: a quien emite. */
  anfitrionId: string | null;
  sesion: SesionDeDirecto;
  /** Un fallo, ya traducido, para la banda de avisos de la sala. */
  alFallar: (texto: string) => void;
  /** Quien emite me ha quitado de la pantalla. */
  alQuitarme: () => void;
};

export type EscenarioEnPantalla = {
  /** El servidor admite invitados. Sin esto no se enseña nada de lo de abajo. */
  disponible: boolean;
  escenario: Escenario;
  /** Estoy en pantalla: acepté EN ESTA VISITA y sigo arriba. */
  enPantalla: boolean;
  /** Tengo una invitación sin contestar. */
  meInvitan: boolean;
  /** Hay un gesto en vuelo: sus botones van deshabilitados. */
  ocupado: boolean;
  recargar: () => void;
  /** `true` si se invitó. El fallo ya se ha contado por `alFallar`. */
  invitar: (usuarioId: string) => Promise<boolean>;
  quitar: (usuarioId: string) => Promise<boolean>;
  aceptar: () => Promise<void>;
  rechazar: () => Promise<void>;
  bajarme: () => Promise<void>;
};

/**
 * El escenario de un directo, visto desde este teléfono.
 *
 * QUÉ HACE Y QUÉ NO. Pregunta al servidor quién está invitado y qué me pasa a
 * mí, manda mis gestos (invitar, aceptar, bajarme) y le dice a la máquina del
 * directo cuándo subir o bajar. NO decide nada: cada gesto es una petición, y
 * lo que se pinta es lo que el servidor contesta. Las reglas están en
 * `live/escenario.ts`.
 *
 * CÓMO SE ENTERA DE LO QUE HACEN LOS DEMÁS. Por un aviso de difusión («el
 * escenario cambió»), que solo sirve para volver a preguntar. Si el aviso se
 * pierde, queda la notificación del teléfono y la lectura al entrar en la sala.
 *
 * SIN CUENTA NO HAY NADA DE ESTO: a quien mira sin haber entrado no se le
 * puede invitar, y preguntar por «lo mío» no significa nada.
 */
export function useEscenarioDeDirecto({
  emisionId,
  enDirecto,
  gestiono,
  anfitrionId,
  sesion,
  alFallar,
  alQuitarme,
}: Opciones): EscenarioEnPantalla {
  const { t } = useTranslation();
  const miId = useAppStore((estado) => estado.user?.id ?? null);

  const [disponible, setDisponible] = useState(false);
  const [escenario, setEscenario] = useState<Escenario>(escenarioVacio);
  const [enPantalla, setEnPantalla] = useState(false);
  const [ocupado, setOcupado] = useState(false);

  /** Acepté en esta visita. Es lo que distingue estar arriba de constar de antes. */
  const subidoAqui = useRef(false);
  const enVuelo = useRef(false);
  const vigente = useRef(true);
  const avisos = useRef<AvisosDelEscenario | null>(null);
  // Lo que cambia en cada render entra por referencia: el canal de avisos no
  // se puede volver a abrir cada vez que la pantalla se repinta.
  const ultimas = useRef({ sesion, alFallar, alQuitarme, gestiono, anfitrionId, t });
  ultimas.current = { sesion, alFallar, alQuitarme, gestiono, anfitrionId, t };

  useEffect(() => {
    vigente.current = true;
    return () => {
      vigente.current = false;
    };
  }, []);

  /** Una lectura del servidor: se pinta, y se obra en consecuencia. */
  const aplicar = useCallback(
    (nuevo: Escenario) => {
      if (!vigente.current) return;
      setDisponible(true);
      setEscenario(nuevo);

      const paso = pasoTrasLeer(nuevo.mio, { subidoAqui: subidoAqui.current });
      if (paso === 'bajar') {
        subidoAqui.current = false;
        setEnPantalla(false);
        ultimas.current.sesion.bajarDelEscenario();
        if (nuevo.mio === 'removed') ultimas.current.alQuitarme();
      } else if (paso === 'soltar_lo_viejo') {
        // De una visita anterior. Se suelta en silencio: la persona no ha
        // hecho nada ahora, y no hay nada que contarle.
        LiveRepository.dejarEscenario(emisionId)
          .then((trasSoltar) => {
            if (vigente.current) setEscenario(trasSoltar);
          })
          .catch(() => {});
      }
    },
    [emisionId],
  );

  const cargar = useCallback(async () => {
    if (!miId || !emisionId) return;
    try {
      aplicar(await LiveRepository.escenario(emisionId));
    } catch (error) {
      // Solo «aquí no se puede invitar» esconde la función. Un fallo de red
      // deja lo que ya se sabía: llegará otro aviso, o se volverá a entrar.
      if (vigente.current && sinInvitados(error)) setDisponible(false);
    }
  }, [aplicar, emisionId, miId]);

  // Mientras hay directo: leer al entrar y escuchar los avisos.
  useEffect(() => {
    if (!enDirecto || !miId || !emisionId) return;
    void cargar();
    const conexion = avisosDelEscenario(emisionId, (carga) => {
      if (meTocaElAviso(carga, miId, ultimas.current.gestiono)) void cargar();
    });
    avisos.current = conexion;
    return () => {
      avisos.current = null;
      conexion.cerrar();
    };
  }, [cargar, emisionId, enDirecto, miId]);

  /*
    MIENTRAS ESTOY ARRIBA SE VUELVE A PREGUNTAR CADA POCO. El aviso de «te han
    quitado» puede perderse —es difusión, no se reintenta—, y entonces el
    servidor ya me habría bajado mientras esta pantalla seguiría enseñando los
    botones de cámara de alguien que ya no emite. Preguntan como mucho los que
    están en pantalla, que son tres: no es carga para nadie.
  */
  useEffect(() => {
    if (!enPantalla || !enDirecto) return;
    const reloj = setInterval(() => void cargar(), REPASO_ESTANDO_ARRIBA_MS);
    return () => clearInterval(reloj);
  }, [cargar, enDirecto, enPantalla]);

  // La emisión terminó: ya no hay escenario del que estar arriba.
  useEffect(() => {
    if (enDirecto) return;
    subidoAqui.current = false;
    setEnPantalla(false);
  }, [enDirecto]);

  /*
    SALIR DE LA SALA ES BAJARSE. Quien se va con la cámara puesta deja de
    emitir —la sala se destruye—, pero seguiría constando como aceptado. Se le
    dice al servidor para que su plaza quede libre y no conste arriba alguien
    que ya no está.
  */
  useEffect(
    () => () => {
      if (!subidoAqui.current) return;
      subidoAqui.current = false;
      LiveRepository.dejarEscenario(emisionId).catch(() => {});
    },
    [emisionId],
  );

  const contarFallo = useCallback((error: unknown) => {
    const { alFallar: avisar, t: traducir } = ultimas.current;
    const clave = claveDelFalloDeEscenario(error instanceof ApiError ? error.code : null);
    avisar(clave ? traducir(clave as TranslationKey) : describeError(error, traducir('live.stageFailed')));
  }, []);

  /** El freno de la doble pulsación, igual que en la máquina del directo. */
  const conFreno = useCallback(async <T,>(accion: () => Promise<T>, siOcupado: T): Promise<T> => {
    if (enVuelo.current) return siOcupado;
    enVuelo.current = true;
    setOcupado(true);
    try {
      return await accion();
    } finally {
      enVuelo.current = false;
      if (vigente.current) setOcupado(false);
    }
  }, []);

  const invitar = useCallback(
    (usuarioId: string) =>
      conFreno(async () => {
        try {
          aplicar(await LiveRepository.invitar(emisionId, usuarioId));
          avisos.current?.avisar(usuarioId);
          return true;
        } catch (error) {
          contarFallo(error);
          return false;
        }
      }, false),
    [aplicar, conFreno, contarFallo, emisionId],
  );

  const quitar = useCallback(
    (usuarioId: string) =>
      conFreno(async () => {
        try {
          aplicar(await LiveRepository.quitarInvitado(emisionId, usuarioId));
          avisos.current?.avisar(usuarioId);
          return true;
        } catch (error) {
          contarFallo(error);
          return false;
        }
      }, false),
    [aplicar, conFreno, contarFallo, emisionId],
  );

  const aceptar = useCallback(
    () =>
      conFreno(async () => {
        try {
          const nuevo = await LiveRepository.responderInvitacion(emisionId, true);
          if (!vigente.current) return;
          // PRIMERO se apunta que subí aquí, y después se pinta: al revés,
          // `aplicar` vería un «aceptado» de otra visita y lo soltaría.
          subidoAqui.current = true;
          setEnPantalla(true);
          aplicar(nuevo);
          ultimas.current.sesion.subirAlEscenario();
          avisos.current?.avisar(ultimas.current.anfitrionId);
        } catch (error) {
          contarFallo(error);
          void cargar();
        }
      }, undefined),
    [aplicar, cargar, conFreno, contarFallo, emisionId],
  );

  const rechazar = useCallback(
    () =>
      conFreno(async () => {
        try {
          aplicar(await LiveRepository.responderInvitacion(emisionId, false));
          avisos.current?.avisar(ultimas.current.anfitrionId);
        } catch (error) {
          contarFallo(error);
          void cargar();
        }
      }, undefined),
    [aplicar, cargar, conFreno, contarFallo, emisionId],
  );

  const bajarme = useCallback(
    () =>
      conFreno(async () => {
        // LA CÁMARA SE APAGA ANTES DE PREGUNTAR A NADIE. Bajarse no puede
        // depender de que haya red: lo primero es dejar de salir.
        subidoAqui.current = false;
        setEnPantalla(false);
        ultimas.current.sesion.bajarDelEscenario();
        try {
          aplicar(await LiveRepository.dejarEscenario(emisionId));
          avisos.current?.avisar(ultimas.current.anfitrionId);
        } catch {
          // Ya no emite. El servidor lo sabrá cuando salga de la sala o cuando
          // quien emite lo quite; no hay nada que la persona pueda hacer.
        }
      }, undefined),
    [aplicar, conFreno, emisionId],
  );

  return {
    disponible: disponible && Boolean(miId),
    escenario,
    enPantalla,
    meInvitan: disponible && enDirecto && escenario.mio === 'invited',
    ocupado,
    recargar: () => void cargar(),
    invitar,
    quitar,
    aceptar,
    rechazar,
    bajarme,
  };
}
