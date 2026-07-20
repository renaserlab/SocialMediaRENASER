import { mockDelay } from '@/services/repositories/_delay';
import { conversations as mockConversations } from '@/data/mockData';
import { isSupabaseConfigured, supabase } from '@/services/supabase';
import type { Conversation } from '@/types';

/**
 * Fuente única de la verdad para las conversaciones.
 *
 * HOY (sin backend): datos mock tras una latencia simulada.
 * MAÑANA (backend): al configurar Supabase se consulta `conversations` con sus
 * mensajes embebidos.
 */
export async function fetchConversations(): Promise<Conversation[]> {
  if (!isSupabaseConfigured || !supabase) {
    await mockDelay();
    return mockConversations;
  }

  const { data, error } = await supabase
    .from('conversations')
    .select('*, messages(*)');
  if (error) {
    throw new Error(error.message);
  }

  // TODO(backend): mapear filas de Supabase (join de messages) al tipo `Conversation`.
  return (data ?? []) as unknown as Conversation[];
}

export async function fetchConversationById(id: string): Promise<Conversation | null> {
  if (!isSupabaseConfigured || !supabase) {
    await mockDelay();
    return mockConversations.find((conversation) => conversation.id === id) ?? null;
  }

  const { data, error } = await supabase
    .from('conversations')
    .select('*, messages(*)')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }

  return data ? (data as unknown as Conversation) : null;
}
