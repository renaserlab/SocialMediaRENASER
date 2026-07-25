import { profileImageUrl } from '@/services/storage';
import type { Conversation, Message } from '@/types';

export type MsgAuthorDto = {
  id: string;
  full_name: string;
  username: string | null;
  avatar_path: string | null;
};

export type ConversationDto = {
  id: string;
  kind: string;
  title: string | null;
  other: MsgAuthorDto | null;
  last_message: string | null;
  last_message_at: string | null;
  unread_count: number;
  updated_at: string;
};

export type MessageDto = {
  id: string;
  conversation_id: string;
  sender: MsgAuthorDto;
  body: string;
  created_at: string;
};

/** Fila cruda de la tabla messages que entrega Supabase Realtime. */
export type MessageRow = {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  created_at: string;
};

export function formatTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function toConversation(dto: ConversationDto): Conversation {
  return {
    id: dto.id,
    name: dto.other?.full_name || dto.title || 'Conversación',
    subtitle: dto.last_message ?? 'Sin mensajes aún',
    unread: dto.unread_count,
    messages: [],
    time: formatTime(dto.last_message_at),
    // El backend ya manda al otro participante con su foto; antes se descartaba
    // y la lista pintaba imagenes de muestra segun la posicion de la fila, de
    // modo que quien tenia foto salia con la de otra persona.
    avatarUrl: profileImageUrl(dto.other?.avatar_path) ?? undefined,
    otherId: dto.other?.id,
  };
}

export function toMessage(dto: MessageDto, currentUserId?: string | null): Message {
  return {
    id: dto.id,
    text: dto.body,
    sender: currentUserId && dto.sender.id === currentUserId ? 'me' : 'them',
    createdAt: formatTime(dto.created_at),
  };
}

/** Mapea una fila de Realtime (solo trae sender_id, no el perfil). */
export function toMessageFromRow(row: MessageRow, currentUserId?: string | null): Message {
  return {
    id: row.id,
    text: row.body,
    sender: currentUserId && row.sender_id === currentUserId ? 'me' : 'them',
    createdAt: formatTime(row.created_at),
  };
}
