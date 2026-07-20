import { supabase } from '@/services/supabase';
import type { MessageRow } from '@/mappers/messageMapper';

// Contador para nombres de canal únicos: evita reusar un canal ya suscrito
// (Supabase lanza "cannot add postgres_changes callbacks after subscribe()"
// si se hace .on() sobre un canal existente, p. ej. al re-montar el efecto).
let channelSeq = 0;

/**
 * Suscribe a los mensajes nuevos de una conversación vía Supabase Realtime.
 * Devuelve una función para cancelar la suscripción.
 */
export function subscribeToConversation(
  conversationId: string,
  onInsert: (row: MessageRow) => void,
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
    .subscribe();

  return () => {
    void client.removeChannel(channel);
  };
}
