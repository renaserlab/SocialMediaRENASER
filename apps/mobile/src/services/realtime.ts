import { supabase } from '@/services/supabase';
import type { MessageRow } from '@/mappers/messageMapper';

// Contador para nombres de canal únicos: evita reusar un canal ya suscrito
// (Supabase lanza "cannot add postgres_changes callbacks after subscribe()"
// si se hace .on() sobre un canal existente, p. ej. al re-montar el efecto).
let channelSeq = 0;

/**
 * Suscribe a los mensajes nuevos de una conversación vía Supabase Realtime.
 * Devuelve una función para cancelar la suscripción.
 *
 * `alCambiar` DICE SI EL CANAL ESTÁ ENGANCHADO, y no es un detalle. El canal
 * no avisa de lo que se pierde: mientras se engancha, y cada vez que se cae
 * —la red cambia, el teléfono duerme— y vuelve, lo que entró en medio NO llega
 * por aquí ni llegará después. Quien pinta un chat necesita saberlo para
 * preguntar al servidor lo que falta (`true`, cada vez que se engancha o se
 * reengancha) y para no fiarse del canal mientras está caído (`false`).
 */
export function subscribeToConversation(
  conversationId: string,
  onInsert: (row: MessageRow) => void,
  alCambiar?: (enganchado: boolean) => void,
): () => void {
  const client = supabase;
  if (!client) return () => {};

  channelSeq += 1;
  const channel = client
    .channel(`messages:${conversationId}:${channelSeq}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `conversation_id=eq.${conversationId}`,
      },
      (payload: { new: MessageRow }) => onInsert(payload.new),
    )
    .subscribe((estado) => alCambiar?.(estado === 'SUBSCRIBED'));

  return () => {
    void client.removeChannel(channel);
  };
}

/**
 * Avisa de CUALQUIER cambio en los mensajes de una conversación: uno nuevo, y
 * también uno que se borra (borrar es marcar la fila, o sea un cambio).
 *
 * NO ENTREGA LA FILA, a propósito. Quien escucha —la pantalla de contenido por
 * vistas— no puede decidir con la fila si el mensaje pertenece a lo que está
 * mirando: eso lo sabe el servidor. Aquí solo se dice «algo cambió, vuelve a
 * preguntar».
 *
 * El chat sigue con `subscribeToConversation`, que sí entrega la fila para
 * pintar la burbuja al instante.
 */
export function subscribeToConversationChanges(
  conversationId: string,
  alCambiar: () => void,
): () => void {
  const client = supabase;
  if (!client) return () => {};

  channelSeq += 1;
  const channel = client
    .channel(`messages-changes:${conversationId}:${channelSeq}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'messages',
        filter: `conversation_id=eq.${conversationId}`,
      },
      () => alCambiar(),
    )
    .subscribe();

  return () => {
    void client.removeChannel(channel);
  };
}

/**
 * «Alguien ha reaccionado en esta conversación: vuelve a preguntar».
 *
 * Una reacción no es un mensaje nuevo: cambia uno que ya está en pantalla, y
 * el canal de mensajes no se entera. Quien reacciona manda este aviso por
 * difusión y los demás preguntan a la API por las reacciones de lo que ven.
 *
 * EL AVISO NO LLEVA NADA: ni quién, ni a qué mensaje, ni con qué. Un canal de
 * difusión lo puede escuchar —y escribir— cualquiera con la aplicación, así
 * que no puede transportar nada que importe. Lo peor que consigue quien mande
 * avisos falsos es que los demás pregunten una vez de más, y lo que les
 * contesta la API es lo que de verdad pueden ver.
 */
export function avisosDeReacciones(
  conversationId: string,
  alAvisar: () => void,
): { avisar: () => void; cerrar: () => void } {
  const client = supabase;
  if (!client || !conversationId) return { avisar: () => {}, cerrar: () => {} };

  // SIN contador en el nombre: todos los teléfonos de la conversación tienen
  // que estar en el MISMO canal para oírse. `self: false` evita oírse a uno
  // mismo, que ya pintó su propia reacción.
  const channel = client
    .channel(`chat-reacciones:${conversationId}`, { config: { broadcast: { self: false } } })
    .on('broadcast', { event: 'reaccion' }, () => alAvisar())
    .subscribe();

  return {
    avisar: () => {
      void channel.send({ type: 'broadcast', event: 'reaccion', payload: {} });
    },
    cerrar: () => {
      void client.removeChannel(channel);
    },
  };
}

/**
 * «Alguien ha leído en esta conversación: vuelve a preguntar».
 *
 * Igual que con las reacciones, y por lo mismo: que una persona abra el chat
 * no crea ningún mensaje, así que el canal de mensajes no se entera. Quien lee
 * manda este aviso DESPUÉS de que el servidor anote su lectura, y los demás le
 * preguntan a la API hasta dónde ha leído cada quien.
 *
 * EL AVISO NO LLEVA NADA, ni quién leyó. Lo peor que consigue quien mande
 * avisos falsos es una pregunta de más; lo que contesta la API es lo cierto.
 */
export function avisosDeLectura(
  conversationId: string,
  alAvisar: () => void,
): { avisar: () => void; cerrar: () => void } {
  const client = supabase;
  if (!client || !conversationId) return { avisar: () => {}, cerrar: () => {} };

  // SE AVISA AL ABRIR EL CHAT, que es justo cuando el canal todavía se está
  // uniendo. Un aviso mandado antes de estar dentro no le llega a nadie, así
  // que el que llegue pronto espera a que el canal esté listo.
  let unido = false;
  let debeAvisar = false;
  const mandar = () => {
    void channel.send({ type: 'broadcast', event: 'leido', payload: {} });
  };
  const channel = client
    .channel(`chat-lecturas:${conversationId}`, { config: { broadcast: { self: false } } })
    .on('broadcast', { event: 'leido' }, () => alAvisar())
    .subscribe((estado: string) => {
      unido = estado === 'SUBSCRIBED';
      if (unido && debeAvisar) {
        debeAvisar = false;
        mandar();
      }
    });

  return {
    avisar: () => {
      if (unido) mandar();
      else debeAvisar = true;
    },
    cerrar: () => {
      void client.removeChannel(channel);
    },
  };
}

/**
 * «Está escribiendo», entre los teléfonos que tienen la conversación abierta.
 *
 * No se guarda en ningún sitio: es difusión pura, y caduca sola en quien la
 * recibe (`lib/escribiendo`). Lo que viaja es SOLO un identificador y si
 * escribe o paró; el nombre no, porque a un canal que puede escribir
 * cualquiera no se le cree. Quien recibe decide a quién le hace caso.
 */
export function canalDeEscritura(
  conversationId: string,
  alRecibir: (aviso: unknown) => void,
): { avisar: (aviso: Record<string, unknown>) => void; cerrar: () => void } {
  const client = supabase;
  if (!client || !conversationId) return { avisar: () => {}, cerrar: () => {} };

  let unido = false;
  const channel = client
    .channel(`chat-escribiendo:${conversationId}`, { config: { broadcast: { self: false } } })
    .on('broadcast', { event: 'escribe' }, (mensaje: { payload?: unknown }) =>
      alRecibir(mensaje?.payload),
    )
    .subscribe((estado: string) => {
      unido = estado === 'SUBSCRIBED';
    });

  return {
    // Antes de estar dentro del canal el aviso se pierde, y no pasa nada: el
    // siguiente sale a los pocos segundos si la persona sigue tecleando.
    avisar: (aviso) => {
      if (!unido) return;
      void channel.send({ type: 'broadcast', event: 'escribe', payload: aviso });
    },
    cerrar: () => {
      void client.removeChannel(channel);
    },
  };
}
