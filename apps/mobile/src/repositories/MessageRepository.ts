import { apiRequest, API_V1 } from '@/services/api';
import {
  ConversationDto,
  MessageDto,
  toConversation,
  toMessage,
} from '@/mappers/messageMapper';
import { firmarAdjuntos, type AdjuntoSubido } from '@/services/messageMedia';
import type { Conversation, Message } from '@/types';

/**
 * Cuántas conversaciones se piden de una vez.
 *
 * Antes se pedían TODAS. En el servidor eso costaba una consulta por
 * conversación —el listado entero eran decenas de viajes a la base— y en el
 * teléfono, descargar y pintar una lista que no cabe en la pantalla. Veinte
 * llenan de sobra la primera pantalla; el resto llega al bajar.
 */
export const CONVERSACIONES_POR_PAGINA = 20;

/**
 * Cuántos mensajes trae cada página del historial.
 *
 * Treinta es más de lo que cabe en una pantalla —así al abrir el chat ya se
 * puede subir un poco sin esperar— y bastante menos que los cincuenta que se
 * pedían antes de golpe.
 */
export const MENSAJES_POR_PAGINA = 30;

/**
 * Pone la URL firmada en cada adjunto de una tanda de mensajes.
 *
 * Se firman TODAS las rutas de la tanda en UNA llamada y no una por burbuja:
 * cada firma es una petición a Supabase, y abrir un chat con veinte fotos
 * costaría veinte. Es el mismo N+1 que se acaba de quitar del backend, pero en
 * el teléfono.
 *
 * Si la firma falla, el mensaje se devuelve igual: se lee el texto y el adjunto
 * enseña su hueco. Quedarse sin foto no puede dejar sin chat.
 */
async function conUrlsFirmadas(mensajes: Message[]): Promise<Message[]> {
  const rutas = mensajes.flatMap((mensaje) =>
    (mensaje.attachments ?? []).map((adjunto) => adjunto.storagePath),
  );
  if (rutas.length === 0) return mensajes;

  const firmas = await firmarAdjuntos(rutas);
  return mensajes.map((mensaje) =>
    mensaje.attachments?.length
      ? {
          ...mensaje,
          attachments: mensaje.attachments.map((adjunto) => ({
            ...adjunto,
            url: firmas[adjunto.storagePath],
          })),
        }
      : mensaje,
  );
}

export const MessageRepository = {
  /**
   * Una página de la bandeja.
   *
   * LOS CHATS DIRECTOS SIN NINGÚN MENSAJE NO VIENEN, y no es un descuido del
   * servidor que haya que compensar aquí. Pulsar «Mensaje» en un perfil CREA la
   * conversación aunque después no se escriba nada —la pantalla de chat
   * necesita un id al que ir—, y eso llenaba la bandeja de filas «Sin mensajes
   * aún» de gente con la que nunca se había hablado. El filtro está en la
   * consulta del listado, que es el único sitio donde puede convivir con la
   * paginación: si se hiciera aquí, `hayMas` contaría filas que ya no están y
   * las páginas llegarían medio vacías.
   *
   * En cuanto alguien escribe, la conversación aparece sola en la siguiente
   * carga. No hay nada que sincronizar desde el teléfono.
   */
  async listConversations(
    { limit = CONVERSACIONES_POR_PAGINA, offset = 0 } = {},
  ): Promise<Conversation[]> {
    const dtos = await apiRequest<ConversationDto[]>(
      `${API_V1}/conversations?limit=${limit}&offset=${offset}`,
    );
    return dtos.map(toConversation);
  },

  /**
   * El chat directo con alguien, creándolo si hace falta.
   *
   * ES IDEMPOTENTE EN EL SERVIDOR: llamarlo tres veces devuelve la MISMA
   * conversación. Antes no lo era —dos peticiones a la vez creaban dos chats, y
   * la bandeja acababa enseñando a la misma persona repetida— y lo único que lo
   * frenaba era el cerrojo `chatBusy` de `ProfileScreen`, que es de este
   * teléfono y no cubre el reintento de una red lenta. Ese cerrojo se queda
   * donde está porque evita la petición de más, pero ya no es lo que garantiza
   * nada: la garantía es la clave primaria de `direct_conversation_pairs`
   * (migración 0039).
   *
   * Por eso reintentar esta llamada es seguro y no hace falta deduplicar aquí.
   */
  async getOrCreateDirect(userId: string): Promise<Conversation> {
    const dto = await apiRequest<ConversationDto>(`${API_V1}/conversations/direct`, {
      method: 'POST',
      body: JSON.stringify({ user_id: userId }),
    });
    return toConversation(dto);
  },

  /**
   * Una página del historial.
   *
   * `before` es el instante del mensaje más antiguo que ya se tiene, y es lo
   * que permite subir por el historial mientras siguen ENTRANDO mensajes por
   * arriba: con un desplazamiento por posición, cada mensaje nuevo corre la
   * ventana un puesto y la página siguiente repite o se salta filas.
   */
  async listMessages(
    conversationId: string,
    currentUserId?: string | null,
    { before, limit = MENSAJES_POR_PAGINA }: { before?: string; limit?: number } = {},
  ): Promise<Message[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set('before', before);
    const dtos = await apiRequest<MessageDto[]>(
      `${API_V1}/conversations/${conversationId}/messages?${params.toString()}`,
    );
    return conUrlsFirmadas(dtos.map((d) => toMessage(d, currentUserId)));
  },

  /**
   * Lo que ha entrado DESPUES de un instante.
   *
   * Existe por los adjuntos: Realtime entrega la fila cruda de `messages`, que
   * no sabe nada de los archivos que cuelgan de ella. La burbuja de texto sale
   * al instante y esto la completa, en UNA petición para toda la ráfaga en vez
   * de una por mensaje. De paso repara lo que Realtime se pierda —el teléfono
   * estuvo en segundo plano, el canal se cayó— sin recargar el historial.
   */
  async listMessagesSince(
    conversationId: string,
    after: string,
    currentUserId?: string | null,
    limit = MENSAJES_POR_PAGINA,
  ): Promise<Message[]> {
    const params = new URLSearchParams({ limit: String(limit), after });
    const dtos = await apiRequest<MessageDto[]>(
      `${API_V1}/conversations/${conversationId}/messages?${params.toString()}`,
    );
    return conUrlsFirmadas(dtos.map((d) => toMessage(d, currentUserId)));
  },

  /**
   * Manda un mensaje: solo texto, solo archivos, o las dos cosas.
   *
   * Los archivos ya están SUBIDOS cuando se llega aquí (ver `messageMedia.ts`):
   * aquí solo viajan sus rutas. Es lo que permite mandar un vídeo grande por
   * trozos reanudables sin que la API sostenga la conexión mientras tanto.
   */
  async sendMessage(
    conversationId: string,
    body: string,
    currentUserId?: string | null,
    attachments: AdjuntoSubido[] = [],
  ): Promise<Message> {
    const dto = await apiRequest<MessageDto>(
      `${API_V1}/conversations/${conversationId}/messages`,
      { method: 'POST', body: JSON.stringify({ body, attachments }) },
    );
    const [mensaje] = await conUrlsFirmadas([toMessage(dto, currentUserId)]);
    return mensaje ?? toMessage(dto, currentUserId);
  },

  async markRead(conversationId: string): Promise<void> {
    await apiRequest<void>(`${API_V1}/conversations/${conversationId}/read`, {
      method: 'POST',
    });
  },
};
