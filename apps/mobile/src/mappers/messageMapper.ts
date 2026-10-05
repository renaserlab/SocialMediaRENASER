import { profileImageUrl } from '@/services/storage';
import type {
  Conversation,
  Message,
  MessageAttachment,
  MensajeDeSesion,
  MessageStoryContext,
} from '@/types';

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
  /**
   * Las etiquetas del CRM de QUIEN PREGUNTA (migración 0045).
   *
   * Opcional a propósito, como `attachments` en un mensaje y por lo mismo: una
   * API anterior a este trabajo no manda el campo, y un mapeador que lo diera
   * por seguro dejaría la bandeja entera en blanco por una función que todavía
   * no está desplegada.
   */
  labels?: { id: string; nombre: string }[];
};

export type AttachmentDto = {
  id: string;
  storage_path: string;
  /** `audio` son las notas de voz; lo añade la migración 0044. */
  kind: 'image' | 'video' | 'document' | 'audio';
  mime_type: string | null;
  file_name: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  duration_s: number | null;
};

/**
 * El contexto de una respuesta a una historia, tal y como lo manda el servidor.
 *
 * `story_id` viene a `null` cuando la historia ya no existe —caducó o su autor
 * la borró—, que es el caso normal pasadas 24 horas. `story_owner` no viene
 * nunca a nulo: es lo único que sigue diciendo de quién era.
 */
export type StoryContextDto = {
  story_id: string | null;
  story_owner: MsgAuthorDto;
  available: boolean;
  media_path: string | null;
  media_type: string | null;
  caption: string | null;
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
  /**
   * Cuándo lo borró quien lo escribió, o `null`.
   *
   * Opcional como `attachments` y por lo mismo: una API anterior a este trabajo
   * no manda el campo, y un mapeador que lo diera por seguro dejaría el chat en
   * blanco por una función que todavía no está desplegada.
   */
  deleted_at?: string | null;
  /**
   * A qué historia respondía, si respondía a alguna.
   *
   * Opcional como los dos de arriba y por lo mismo: una API anterior a la 0044
   * no manda el campo, y un mapeador que lo diera por seguro dejaría el chat
   * entero en blanco por una función que todavía no está desplegada.
   */
  story_context?: StoryContextDto | null;
  /**
   * De qué sesión 1:1 habla, si habla de alguna.
   *
   * Opcional por lo mismo que los de arriba: una API anterior a la 0097 no
   * manda el campo y el mensaje se pinta como texto, que es lo que es.
   */
  booking_context?: BookingContextDto | null;
};

/** La sesión de la que habla un mensaje, tal y como la manda la API. */
export type BookingContextDto = {
  booking_id: string;
  event: MensajeDeSesion['hecho'];
  status: MensajeDeSesion['estado'];
  topic: string;
  note?: string | null;
  scheduled_at?: string | null;
  timezone?: string | null;
  my_role: 'provider' | 'requester';
  updated_at?: string | null;
};

export function toSesionDelMensaje(dto: BookingContextDto): MensajeDeSesion {
  return {
    sesionId: dto.booking_id,
    hecho: dto.event,
    estado: dto.status,
    tema: dto.topic,
    nota: dto.note ?? '',
    cuandoIso: dto.scheduled_at ?? null,
    miPapel: dto.my_role === 'provider' ? 'provider' : 'requester',
    actualizadaIso: dto.updated_at ?? null,
  };
}

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
    // `?? []` y no `dto.labels`: la fila pinta `labels.length` sin comprobar
    // nada, y una API vieja que no mande el campo no puede reventar la bandeja.
    labels: dto.labels ?? [],
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

/**
 * El contexto de historia, ya listo para pintarlo.
 *
 * TRADUCE EL NULO A UN ESTADO CON NOMBRE. `story_id: null` no es un dato que
 * falte: significa que la historia ya no existe, y la burbuja tiene que
 * escribir «Historia no disponible». Dejar que cada pantalla dedujera eso de un
 * nulo es como se acaba pintando un hueco vacío sin explicación.
 *
 * `available` se cruza con la presencia real del identificador en vez de
 * creérselo a secas: son dos formas de decir lo mismo y basta con que una falle
 * —una API a medio desplegar, un campo nuevo que no llega— para acabar pidiendo
 * la miniatura de una historia que no está.
 */
export function toStoryContext(dto: StoryContextDto): MessageStoryContext {
  const disponible = dto.available === true && !!dto.story_id;
  return {
    storyId: dto.story_id ?? undefined,
    autor: {
      id: dto.story_owner.id,
      nombre: dto.story_owner.full_name,
      usuario: dto.story_owner.username,
    },
    disponible,
    mediaPath: disponible ? dto.media_path ?? undefined : undefined,
    // Solo hay dos tipos de historia. Cualquier otra cosa se trata como imagen:
    // en la miniatura de una respuesta lo único que cambia es si lleva el
    // triangulito de play encima, y equivocarse por ahí no rompe nada.
    mediaType: disponible ? (dto.media_type === 'video' ? 'video' : 'image') : undefined,
    caption: disponible ? dto.caption ?? undefined : undefined,
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
    /*
      EL SERVIDOR YA MANDA LA BURBUJA VACIA. `body` viene en blanco y sin
      adjuntos: el texto borrado no viaja, asi que aqui no hay nada que
      esconder — solo que decir que hubo algo.
    */
    eliminado: !!dto.deleted_at,
    attachments: (dto.attachments ?? []).map(toAttachment),
    // El servidor ya NO manda contexto en un mensaje borrado: una lápida no
    // enseña a qué respondía. Aquí no hay nada que esconder.
    storyContext: dto.story_context ? toStoryContext(dto.story_context) : undefined,
    sesion: dto.booking_context ? toSesionDelMensaje(dto.booking_context) : undefined,
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
