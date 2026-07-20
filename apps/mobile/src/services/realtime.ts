import { supabase } from '@/services/supabase';
import type { MessageRow } from '@/mappers/messageMapper';

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

  const channel = client
    .channel(`messages:${conversationId}`)
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
