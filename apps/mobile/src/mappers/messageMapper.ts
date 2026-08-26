import { profileImageUrl } from '@/services/storage';
import type { Conversation, Message, MessageAttachment } from '@/types';

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

export type AttachmentDto = {
  id: string;
  storage_path: string;
  kind: 'image' | 'video' | 'document';
  mime_type: string | null;
  file_name: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  duration_s: number | null;
};

export type MessageDto = {
  id: string;
  conversation_id: string;
  sender: MsgAuthorDto;
  body: string;
  created_at: string;
  /**
   * Opcional a propósito: mientras la migración 0033 espere aprobación el
   * backend no manda este campo, y un mapeador que lo diera por seguro dejaría
   * el chat entero en blanco por una función que todavía no está.
   */
  attachments?: AttachmentDto[];
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

export function toAttachment(dto: AttachmentDto): MessageAttachment {
  return {
    id: dto.id,
    storagePath: dto.storage_path,
    kind: dto.kind,
    mimeType: dto.mime_type,
    fileName: dto.file_name,
    bytes: dto.bytes,
    width: dto.width,
    height: dto.height,
    durationS: dto.duration_s,
  };
}

export function toMessage(dto: MessageDto, currentUserId?: string | null): Message {
  return {
    id: dto.id,
    text: dto.body,
    sender: currentUserId && dto.sender.id === currentUserId ? 'me' : 'them',
    createdAt: formatTime(dto.created_at),
    // El instante sin formatear: es lo que ordena la lista y lo que se manda
    // como `before`/`after`. `createdAt` solo lleva hora y minuto.
    createdAtIso: dto.created_at,
    attachments: (dto.attachments ?? []).map(toAttachment),
  };
}

/**
 * Mapea una fila de Realtime.
 *
 * La fila cruda de `messages` NO sabe nada de los archivos que cuelgan de ella:
 * Realtime entrega la tabla, no la respuesta del API. Por eso el mensaje sale
 * de aquí sin adjuntos y la pantalla los completa después pidiendo las
 * novedades con `after`, en una sola petición para toda la ráfaga. El texto se
 * pinta al instante, que es lo que hace que un chat se sienta vivo.
 */
export function toMessageFromRow(row: MessageRow, currentUserId?: string | null): Message {
  return {
    id: row.id,
    text: row.body,
    sender: currentUserId && row.sender_id === currentUserId ? 'me' : 'them',
    createdAt: formatTime(row.created_at),
    createdAtIso: row.created_at,
  };
}
