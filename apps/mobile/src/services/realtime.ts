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
