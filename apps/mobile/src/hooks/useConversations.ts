import { useCallback, useEffect, useMemo, useState } from 'react';

import { fetchConversations } from '@/services/repositories/conversations';
import { isSupabaseConfigured } from '@/services/supabase';
import { useAppStore } from '@/store/useAppStore';
import type { Conversation } from '@/types';

/**
 * Carga las conversaciones vía repositorio y las deja en el store.
 *
 * - Backend activo: el servidor es la fuente de verdad → reemplaza el store.
 * - Modo mock: conserva las conversaciones del store (persistencia + mensajes
 *   enviados en la demo) y solo simula la latencia para el estado de carga.
 *
 * El estado interactivo (enviar mensaje) sigue viviendo en el store, por eso las
 * pantallas leen las conversaciones desde ahí y se actualizan solas.
 */
function useLoadConversations() {
  const setConversations = useAppStore((state) => state.setConversations);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fresh = await fetchConversations();
      if (isSupabaseConfigured) {
        setConversations(fresh);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar las conversaciones.');
    } finally {
      setLoading(false);
    }
  }, [setConversations]);

  useEffect(() => {
    load();
  }, [load]);

  return { loading, error, reload: load };
}

/** Lista de conversaciones para MessagesScreen. */
export function useConversations() {
  const conversations = useAppStore((state) => state.conversations);
  const { loading, error, reload } = useLoadConversations();
  return { conversations, loading, error, reload };
}

// Conversación sintética del mentor: se genera al vuelo si aún no existe en el store.
const DARREN_CONVERSATION: Conversation = {
  id: 'darren',
  name: 'Darren Hardy',
  subtitle: 'Mentor de líderes',
  unread: 0,
  messages: [
    {
      id: 'd1',
      sender: 'them',
      text: '¡Hola! Qué gusto saludarte. ¿En qué puedo apoyarte hoy en tu camino de crecimiento?',
      createdAt: '10:00 AM',
    },
  ],
};

/**
 * Una conversación por id para ChatScreen. Se lee del store (reactivo: los
 * mensajes enviados aparecen al instante) con el caso especial del mentor.
 */
export function useConversation(id?: string) {
  const conversations = useAppStore((state) => state.conversations);
  const { loading, error, reload } = useLoadConversations();

  const conversation = useMemo<Conversation | null>(() => {
    const found = conversations.find((item) => item.id === id);
    if (found) return found;
    if (id === 'darren') return DARREN_CONVERSATION;
    return null;
  }, [conversations, id]);

  return { conversation, loading, error, reload };
}
