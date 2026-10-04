import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useRouter } from 'expo-router';

import { traduceEnElIdiomaActual } from '@/i18n';
import { rutaDelAviso } from '@/lib/avisosAlCreador';
import { adelantarMarca, destinoDelAviso, queAnunciar } from '@/lib/avisosNuevos';
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

type FilaDeMensaje = { conversation_id?: string; sender_id?: string };

/**
 * El puente con el oyente del push (`useAvisosDelPush`), que vive en otro
 * fichero porque solo existe en el teléfono. Cuando llega un push con la
 * aplicación abierta, ese oyente enseña el aviso y llama aquí para que la
 * lectura periódica no lo anuncie otra vez y los contadores se pongan al día.
 */
let ponerseAlDia: (() => void) | null = null;

export function alRecibirUnPush(): void {
  ponerseAlDia?.();
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
 *   - LO DEMÁS, CADA MINUTO y al volver a la aplicación: se pregunta cuántos
 *     avisos hay sin leer y, si han subido, se piden los últimos y se anuncian
 *     los nuevos. No hay un segundo sistema: es la misma bandeja y el mismo
 *     aviso flotante (`avisar`, con su cola y su deduplicación).
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
    let cuentaAnterior: number | null = null;
    let yo: string | null = null;

    const abrir = (ruta: string) => navegar.current.push(ruta as never);

    /* ------------------------------------------------ avisos de la bandeja */
    const mirarAvisos = async () => {
      const cuenta = await refrescarNotificaciones();
      if (!vivo || cuenta === null) return;
      const subio = cuentaAnterior !== null && cuenta > cuentaAnterior;
      const primera = marca === null;
      cuentaAnterior = cuenta;
      // La lista solo se pide cuando hace falta: al empezar, para fijar la
      // marca, y cuando la cuenta sube. Un minuto tras otro sin novedad es una
      // consulta de un número, nada más.
      if (!primera && !subio) return;
      try {
        const avisos = await NotificationRepository.list();
        if (!vivo) return;
        const resultado = queAnunciar(avisos, marca);
        marca = resultado.marca;
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
          // La misma clave que el push: si llegan los dos, es UN aviso.
          clave: claveDeConversacion(id),
          alTocar: () => abrir(`/chat/${id}`),
        });
      }
    };

    const alLlegarMensaje = (fila: FilaDeMensaje) => {
      if (!fila.conversation_id || fila.sender_id === yo) return;
      pendientes.add(fila.conversation_id);
      if (respiro === null) respiro = setTimeout(() => void mirarMensajes(), RESPIRO_DE_MENSAJES_MS);
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
    void cliente?.auth.getSession().then(({ data }) => {
      yo = data.session?.user?.id ?? null;
    });
    void mirarAvisos();
    void refrescarMensajes();

    const reloj = setInterval(() => {
      // Con la aplicación en segundo plano no se pregunta: para eso está el push.
      if (AppState.currentState === 'active') void mirarAvisos();
    }, CADA_MS);

    const alVolver = AppState.addEventListener('change', (estado) => {
      if (estado !== 'active') return;
      void mirarAvisos();
      void refrescarMensajes();
    });

    /* Un push recibido con la aplicación abierta ya salió en pantalla. */
    ponerseAlDia = () => {
      marca = adelantarMarca(marca, Date.now());
      cuentaAnterior = null;
      void refrescarNotificaciones().then((cuenta) => {
        if (vivo && cuenta !== null) cuentaAnterior = cuenta;
      });
      void refrescarMensajes();
    };

    return () => {
      vivo = false;
      ponerseAlDia = null;
      clearInterval(reloj);
      if (respiro !== null) clearTimeout(respiro);
      alVolver.remove();
      if (cliente && canal) void cliente.removeChannel(canal);
    };
  }, [supabaseEnabled, conSesion]);
}
