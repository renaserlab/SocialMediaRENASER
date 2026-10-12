import { useCallback, useEffect, useRef, useState } from 'react';

import { useTranslation } from '@/i18n/useTranslation';
import { describeError } from '@/lib/describeError';
import {
  MENSAJES_POR_PAGINA_DE_VISTA,
  claveDeVista,
  crearTurnos,
  fundirPaginas,
  refrescarPrimeraPagina,
  type CursorDeVista,
  type VistaElegida,
} from '@/lib/vistasDeChat';
import { MessageRepository, type MensajeDeVista } from '@/repositories/MessageRepository';
import { subscribeToConversationChanges } from '@/services/realtime';

/** Como mucho una recarga por mensajes nuevos cada tanto. */
const ESPERA_ENTRE_RECARGAS_MS = 2000;

type Opciones = {
  /** Lo que se busca DENTRO de la vista. Vacío: todo. */
  buscar?: string;
  /**
   * Lo que decide el resultado de un filtro. Cuando quien administra lo edita
   * cambia, y la lista que se estaba viendo ya no vale: se pide entera otra vez.
   */
  huella?: string;
  currentUserId?: string | null;
  /** Algo cambió en la conversación: para que quien llama vuelva a leer las cuentas. */
  alHaberCambios?: () => void;
};

export type MensajesDeVista = {
  mensajes: MensajeDeVista[];
  /** La primera página está en camino y todavía no hay nada que enseñar. */
  cargando: boolean;
  cargandoMas: boolean;
  refrescando: boolean;
  /** Por qué falló la primera página; `null` si no falló. */
  fallo: string | null;
  cargarMas: () => void;
  /** El gesto de tirar hacia abajo. */
  refrescar: () => void;
  /** Volver a intentarlo tras un fallo. */
  reintentar: () => void;
};

/**
 * Los mensajes de UNA vista de un chat —una categoría o un filtro—, por
 * páginas y al día.
 *
 * `vista` a `null` es «ahora no se mira ninguna»: no se pide nada. Es lo que
 * pasa en la ficha de un grupo mientras está abierta la pestaña de miembros.
 *
 * NADA SE FILTRA AQUÍ: qué entra en cada vista lo decide el servidor.
 *
 * MENSAJES NUEVOS Y BORRADOS. Cuando algo cambia en la conversación se vuelve
 * a pedir la primera página, como mucho una vez cada dos segundos. No se
 * intenta adivinar si el mensaje pertenece a la vista: eso lo sabe el servidor.
 */
export function useMensajesDeVista(
  conversationId: string,
  vista: VistaElegida | null,
  { buscar = '', huella = '', currentUserId = null, alHaberCambios }: Opciones = {},
): MensajesDeVista {
  const { t } = useTranslation();
  const [mensajes, setMensajes] = useState<MensajeDeVista[]>([]);
  const [siguiente, setSiguiente] = useState<CursorDeVista | null>(null);
  const [cargando, setCargando] = useState(vista !== null);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [refrescando, setRefrescando] = useState(false);
  const [fallo, setFallo] = useState<string | null>(null);

  const turnos = useRef(crearTurnos()).current;
  const enCurso = useRef<AbortController | null>(null);
  const clave = vista ? claveDeVista(vista) : '';
  /** La vista y la búsqueda de ahora mismo, para reconocer respuestas viejas. */
  const loQueSeMira = useRef('');
  loQueSeMira.current = `${clave}|${buscar}`;

  /**
   * Pide la PRIMERA página. `silencioso` es la recarga por un mensaje nuevo o
   * al tirar hacia abajo: no vacía la lista ni enseña el indicador grande, y
   * conserva las páginas ya cargadas por debajo.
   */
  const cargar = useCallback(
    (silencioso: boolean) => {
      if (!conversationId || !vista) return;
      enCurso.current?.abort();
      const control = new AbortController();
      enCurso.current = control;
      const turno = turnos.siguiente();
      if (!silencioso) {
        setCargando(true);
        setFallo(null);
      }
      MessageRepository.mensajesDeVista(conversationId, vista, {
        buscar,
        signal: control.signal,
        currentUserId,
      })
        .then((pagina) => {
          // Solo cuenta la última petición: si se cambió de pestaña mientras
          // esta viajaba, su respuesta ya no es de lo que se está mirando.
          if (!turnos.vigente(turno)) return;
          setMensajes((previos) =>
            silencioso
              ? refrescarPrimeraPagina(previos, pagina.mensajes, MENSAJES_POR_PAGINA_DE_VISTA)
              : pagina.mensajes,
          );
          // En una recarga silenciosa con más páginas cargadas, el cursor que
          // vale es el de la última página, no el de la primera.
          setSiguiente((previo) => (silencioso && previo ? previo : pagina.siguiente));
          setFallo(null);
        })
        .catch((error: unknown) => {
          if (!turnos.vigente(turno) || control.signal.aborted) return;
          // Una recarga silenciosa que falla no tapa lo que ya se ve.
          if (!silencioso) setFallo(describeError(error, t('chatViews.loadError')));
        })
        .finally(() => {
          // El gesto de tirar se suelta siempre, gane quien gane el turno.
          setRefrescando(false);
          if (turnos.vigente(turno)) setCargando(false);
        });
    },
    // `vista` entra por su clave —es un objeto nuevo en cada pintado— y
    // `huella` no se lee dentro: está para que cambiar los criterios del
    // filtro abierto vuelva a lanzar la carga entera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationId, clave, buscar, currentUserId, turnos, t, huella],
  );

  // Al entrar, y cada vez que cambia la vista o lo que se busca.
  useEffect(() => {
    setMensajes([]);
    setSiguiente(null);
    if (!clave) {
      // Ninguna vista: lo que estuviera en camino ya no interesa.
      turnos.siguiente();
      setCargando(false);
      setFallo(null);
      return;
    }
    cargar(false);
    return () => enCurso.current?.abort();
  }, [cargar, clave, turnos]);

  const recargar = useRef(cargar);
  recargar.current = cargar;
  const avisar = useRef(alHaberCambios);
  avisar.current = alHaberCambios;
  useEffect(() => {
    if (!conversationId) return;
    let pendiente: ReturnType<typeof setTimeout> | null = null;
    const desengancha = subscribeToConversationChanges(conversationId, () => {
      if (pendiente) return;
      pendiente = setTimeout(() => {
        pendiente = null;
        recargar.current(true);
        avisar.current?.();
      }, ESPERA_ENTRE_RECARGAS_MS);
    });
    return () => {
      if (pendiente) clearTimeout(pendiente);
      desengancha();
    };
  }, [conversationId]);

  const cargarMas = useCallback(() => {
    if (!conversationId || !vista || !siguiente || cargando || cargandoMas) return;
    // NO toma turno: tomarlo anularía una recarga de la primera página que
    // estuviera en camino. Le basta saber si, al contestar, se sigue mirando
    // la misma vista con la misma búsqueda.
    const pedida = loQueSeMira.current;
    setCargandoMas(true);
    MessageRepository.mensajesDeVista(conversationId, vista, {
      buscar,
      cursor: siguiente,
      currentUserId,
    })
      .then((pagina) => {
        if (loQueSeMira.current !== pedida) return;
        setMensajes((previos) => fundirPaginas(previos, pagina.mensajes));
        setSiguiente(pagina.siguiente);
      })
      .catch(() => {
        // Se queda el cursor: al volver a llegar al final se reintenta.
      })
      .finally(() => setCargandoMas(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, clave, siguiente, cargando, cargandoMas, buscar, currentUserId]);

  const refrescar = useCallback(() => {
    if (!clave) return;
    setRefrescando(true);
    cargar(true);
  }, [cargar, clave]);

  const reintentar = useCallback(() => cargar(false), [cargar]);

  return { mensajes, cargando, cargandoMas, refrescando, fallo, cargarMas, refrescar, reintentar };
}
