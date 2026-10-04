import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useRouter } from 'expo-router';

import { traduceEnElIdiomaActual } from '@/i18n';
import { rutaDelAviso } from '@/lib/avisosAlCreador';
import { destinoDelAviso, queAnunciar } from '@/lib/avisosNuevos';
import { seEstaViendoLaConversacion } from '@/lib/loQueSeVe';
import { claveDeConversacion } from '@/lib/rutaDelPush';
import { avisar } from '@/lib/toast';
import { NotificationRepository } from '@/repositories/NotificationRepository';
import { refrescarMensajes, refrescarNotificaciones } from '@/services/contadores';
import { supabase } from '@/services/supabase';
import { useAuthStore } from '@/store/useAuthStore';
import { useContadoresStore } from '@/store/useContadoresStore';

/** Cada cuánto se pregunta por avisos nuevos con la aplicación abierta. */
const CADA_MS = 60_000;
/** Varios mensajes seguidos son una sola consulta, pasado este respiro. */
const RESPIRO_DE_MENSAJES_MS = 500;
/** Cuántos mensajes ya anunciados se recuerdan para no repetirlos. */
const MENSAJES_RECORDADOS = 200;

type FilaDeMensaje = { id?: string; conversation_id?: string; sender_id?: string };

/**
 * El puente con el oyente del push (`useAvisosDelPush`), que vive en otro
 * fichero porque solo existe en el teléfono.
 *
 * - `ponerseAlDia`: llegó un push con la aplicación abierta y ya se enseñó. La
 *   lectura periódica no tiene que anunciarlo otra vez.
 * - `mensajeDelPush`: llegó el push DE UN MENSAJE. No se enseña allí: se trae
 *   aquí, al mismo camino que el mensaje en tiempo real, para que los dos
 *   —que son el mismo mensaje— den UN aviso.
 *
 * Son `null` cuando el hook no está escuchando (sin sesión).
 */
let ponerseAlDia: (() => void) | null = null;
let mensajeDelPush: ((conversacionId: string, mensajeId: string | null) => void) | null = null;

export function alRecibirUnPush(): void {
  ponerseAlDia?.();
}

/**
 * Entrega al camino en vivo el push de un mensaje. Devuelve `false` si nadie
 * escucha: entonces quien llama enseña el aviso por su cuenta.
 */
export function alRecibirUnMensajePorPush(conversacionId: string, mensajeId: string | null): boolean {
  if (!mensajeDelPush) return false;
  mensajeDelPush(conversacionId, mensajeId);
  return true;
}

/**
 * Lo que mantiene vivos los avisos mientras la aplicación está ABIERTA.
 *
 * LO REPORTADO. «Cuando se envía un mensaje a un usuario, o cuando se le
 * agenda sesión, o cuando reaccionan a su contenido… no aparecen las
 * notificaciones. Deben aparecer tanto en la bandeja como también un mensaje
 * flotante». Con la aplicación abierta no había nada escuchando: la campana
 * solo se actualizaba al volver a Explorar y el globo de Mensajes no se movía
 * nunca.
 *
 * QUÉ HACE, sin depender del push —que necesita una compilación con las
 * credenciales de Google y de Apple—:
 *
 *   - MENSAJES, AL MOMENTO. Se suscribe a los mensajes nuevos de las
 *     conversaciones de esta persona (la tabla ya se publicaba en tiempo real
 *     y el servidor solo entrega las filas que puede leer). Al llegar uno de
 *     otra persona se refresca el contador y sale el aviso flotante, salvo que
 *     sea de la conversación que tiene delante.
 *   - LO DEMÁS, CADA MINUTO: se pregunta cuántos avisos hay sin leer y, si han
 *     subido, se piden los últimos y se anuncian los nuevos. No hay un segundo
 *     sistema: es la misma bandeja y el mismo aviso flotante (`avisar`).
 *
 * UN HECHO, UN AVISO.
 *
 *   - Un mensaje llega por dos caminos —tiempo real y push— y los dos acaban
 *     aquí con el identificador del mensaje: el segundo se descarta.
 *   - Lo que llegó mientras la aplicación estaba en segundo plano ya lo avisó
 *     el sistema. Al volver se ponen al día los contadores y la marca SIN
 *     anunciar nada.
 *   - La marca se fija con las fechas del SERVIDOR, nunca con el reloj del
 *     teléfono, que puede ir adelantado o atrasado.
 *
 * TODO SE DESMONTA. Al cerrar sesión o al desmontarse se quitan el canal, el
 * reloj y el oyente de `AppState`; no queda nada preguntando por detrás.
 *
 * Se monta UNA vez, en el layout raíz.
 */
export function useAvisosEnVivo(): void {
  const router = useRouter();
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const conSesion = useAuthStore((state) => state.status === 'authenticated');
  // El navegador puede cambiar de identidad entre renders; el efecto no.
  const navegar = useRef(router);
  navegar.current = router;

  useEffect(() => {
    if (!supabaseEnabled || !conSesion) {
      useContadoresStore.getState().vaciar();
      return undefined;
    }

    let vivo = true;
    /** Hasta cuándo se han visto pasar avisos. `null` hasta la primera lectura. */
    let marca: number | null = null;
    /** Quién soy. `null` hasta que se sabe: mientras tanto no se anuncia nada. */
    let yo: string | null = null;

    const abrir = (ruta: string) => navegar.current.push(ruta as never);

    /* ------------------------------------------------ avisos de la bandeja */
    /**
     * @param callado pone al día los contadores y la marca SIN anunciar. Es lo
     *   que toca cuando lo nuevo ya se avisó por otro lado: el sistema lo hizo
     *   mientras la aplicación estaba en segundo plano, o acaba de salir el
     *   aviso de un push.
     */
    const mirarAvisos = async (callado = false) => {
      /*
        LA CUENTA DE ANTES SE LEE DEL CONTADOR COMÚN, no de una variable de
        aquí. Abrir la bandeja lo pone a cero; con una copia propia, tener 3,
        abrir la bandeja y recibir 1 daba «1 no es más que 3» y ese aviso no
        se anunciaba nunca.
      */
      const antes = useContadoresStore.getState().notificaciones;
      const cuenta = await refrescarNotificaciones();
      if (!vivo || cuenta === null) return;
      const primera = marca === null;
      // La lista solo se pide cuando hace falta: al empezar, para fijar la
      // marca; cuando la cuenta sube; o para ponerse al día sin anunciar. Un
      // minuto tras otro sin novedad es una consulta de un número, nada más.
      if (!primera && !callado && cuenta <= antes) return;
      try {
        const avisos = await NotificationRepository.list();
        if (!vivo) return;
        // Callado es lo mismo que la primera vez: solo se fija la marca.
        const resultado = queAnunciar(avisos, callado ? null : marca);
        marca = Math.max(marca ?? 0, resultado.marca);
        for (const aviso of resultado.anunciar) {
          const destino = destinoDelAviso(aviso, rutaDelAviso);
          avisar({
            tipo: 'notificacion',
            titulo: aviso.title,
            message: aviso.subtitle,
            icon: aviso.icon,
            clave: `aviso:${aviso.id}`,
            alTocar: destino ? () => abrir(destino) : () => abrir('/notifications'),
          });
        }
      } catch {
        /* Se intentará en la siguiente vuelta. */
      }
    };

    /* --------------------------------------------------------- mensajes */
    let respiro: ReturnType<typeof setTimeout> | null = null;
    const pendientes = new Set<string>();
    /** Los mensajes ya anunciados, por identificador. Con tope. */
    const anunciados = new Set<string>();

    const mirarMensajes = async () => {
      respiro = null;
      const deQuien = Array.from(pendientes);
      pendientes.clear();
      const conversaciones = await refrescarMensajes();
      if (!vivo || !conversaciones) return;
      for (const id of deQuien) {
        // El mensaje ya está a la vista: lo pinta la conversación.
        if (seEstaViendoLaConversacion(id)) continue;
        const conversacion = conversaciones.find((c) => c.id === id);
        if (!conversacion) continue;
        avisar({
          tipo: 'notificacion',
          titulo: conversacion.name,
          message: conversacion.subtitle || traduceEnElIdiomaActual('notif.newMessage'),
          avatarUrl: conversacion.avatarUrl ?? null,
          icon: 'message-square',
          clave: claveDeConversacion(id),
          alTocar: () => abrir(`/chat/${id}`),
        });
      }
    };

    /**
     * Un mensaje nuevo, venga del tiempo real o del push. El identificador es
     * lo que hace que los dos caminos den un solo aviso.
     */
    const anotarMensaje = (conversacionId: string, mensajeId: string | null) => {
      if (mensajeId) {
        if (anunciados.has(mensajeId)) return;
        anunciados.add(mensajeId);
        if (anunciados.size > MENSAJES_RECORDADOS) {
          // Se cae el más antiguo: un `Set` conserva el orden de inserción.
          const primero = anunciados.values().next().value;
          if (primero !== undefined) anunciados.delete(primero);
        }
      }
      pendientes.add(conversacionId);
      if (respiro === null) respiro = setTimeout(() => void mirarMensajes(), RESPIRO_DE_MENSAJES_MS);
    };

    const alLlegarMensaje = (fila: FilaDeMensaje) => {
      // Sin saber quién soy no se puede distinguir mi propio mensaje —enviado
      // desde este u otro aparato— del de otra persona: no se anuncia.
      if (!fila.conversation_id || yo === null || fila.sender_id === yo) return;
      anotarMensaje(fila.conversation_id, fila.id ?? null);
    };

    const cliente = supabase;
    const canal = cliente
      ?.channel(`avisos-de-mensajes:${Date.now()}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload: { new: FilaDeMensaje }) => alLlegarMensaje(payload.new),
      )
      .subscribe();

    /* --------------------------------------------------------- arranque */
    cliente?.auth
      .getSession()
      .then(({ data }) => {
        if (vivo) yo = data.session?.user?.id ?? null;
      })
      .catch(() => {
        /* Sin saber quién soy no se anuncian mensajes; lo demás sigue. */
      });
    void mirarAvisos();
    void refrescarMensajes();

    const reloj = setInterval(() => {
      // Con la aplicación en segundo plano no se pregunta: para eso está el push.
      if (AppState.currentState === 'active') void mirarAvisos();
    }, CADA_MS);

    const alVolver = AppState.addEventListener('change', (estado) => {
      if (estado !== 'active') return;
      // Lo que llegó estando fuera ya lo avisó el sistema: al día, sin anunciar.
      void mirarAvisos(true);
      void refrescarMensajes();
    });

    ponerseAlDia = () => {
      void mirarAvisos(true);
      void refrescarMensajes();
    };
    // El push de un mensaje lo manda otra persona: no hace falta saber quién soy.
    mensajeDelPush = anotarMensaje;

    return () => {
      vivo = false;
      ponerseAlDia = null;
      mensajeDelPush = null;
      clearInterval(reloj);
      if (respiro !== null) clearTimeout(respiro);
      alVolver.remove();
      if (cliente && canal) void cliente.removeChannel(canal);
    };
  }, [supabaseEnabled, conSesion]);
}
