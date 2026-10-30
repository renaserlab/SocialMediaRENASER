import { apiRequest, API_V1 } from '@/services/api';
import {
  AttachmentDto,
  ConversationDto,
  MessageDto,
  toAttachment,
  toConversation,
  toMessage,
} from '@/mappers/messageMapper';
import { leerTemasDeMensaje, type TemaDeMensaje } from '@/lib/nombresDeAdjuntos';
import { rutaDePortada } from '@/lib/mediosDeChat';
import { respuestaCompartida } from '@/lib/respuestaCompartida';
import { firmarAdjuntos, type AdjuntoSubido } from '@/services/messageMedia';
import { profileImageUrl, signMediaUrls } from '@/services/storage';
import {
  FILTRO_DE_TEMA_TODOS,
  SIN_VISTAS,
  leerCuentasDeTemas,
  leerCursor,
  leerVistas,
  parametrosDeVista,
  type Categoria,
  type CuentasDeTemas,
  type CursorDeVista,
  type FiltroDeTema,
  type VistaElegida,
  type VistasDeChat,
} from '@/lib/vistasDeChat';
import {
  CONSULTA_VACIA,
  parametrosDeBandeja,
  type ConsultaDeBandeja,
} from '@/lib/bandeja';
import {
  leerDetalles,
  leerMarcas,
  type DetallesDeMensaje,
  type MarcaDeLectura,
} from '@/lib/lecturaDeMensajes';
import {
  leerConsultaDeReacciones,
  leerReacciones,
  type ReaccionDeMensaje,
} from '@/lib/reaccionesDeChat';
import type { Conversation, Message, MessageAttachment } from '@/types';

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
 *
 * LA PORTADA DE CADA VIDEO VA EN LA MISMA LLAMADA: es lo que se pinta en la
 * burbuja, y pedirla aparte sería una segunda petición por cada página.
 */
async function conUrlsFirmadas(mensajes: Message[]): Promise<Message[]> {
  const rutas = mensajes.flatMap((mensaje) =>
    (mensaje.attachments ?? []).flatMap(rutasDeUnAdjunto),
  );
  if (rutas.length === 0) return mensajes;

  const firmas = await firmarAdjuntos(rutas);
  return mensajes.map((mensaje) =>
    mensaje.attachments?.length
      ? {
          ...mensaje,
          attachments: mensaje.attachments.map((adjunto) => conFirmas(adjunto, firmas)),
        }
      : mensaje,
  );
}

/** Lo que hay que firmar para pintar un adjunto: él y, si es un video, su portada. */
function rutasDeUnAdjunto(adjunto: { storagePath: string; kind: string }): string[] {
  return adjunto.kind === 'video'
    ? [adjunto.storagePath, rutaDePortada(adjunto.storagePath)]
    : [adjunto.storagePath];
}

function conFirmas<T extends { storagePath: string; kind: string }>(
  adjunto: T,
  firmas: Record<string, string>,
): T & { url?: string; posterUrl?: string } {
  return {
    ...adjunto,
    url: firmas[adjunto.storagePath],
    posterUrl:
      adjunto.kind === 'video' ? firmas[rutaDePortada(adjunto.storagePath)] : undefined,
  };
}

/**
 * Pone la miniatura de la historia en los mensajes que responden a una.
 *
 * SE FIRMAN TODAS DE UNA VEZ, igual que los adjuntos y por lo mismo: cada firma
 * es una petición, y un historial con diez respuestas a historias costaría diez.
 *
 * SOLO LAS QUE SIGUEN EXISTIENDO. Un contexto degradado —la historia caducó o
 * su autor la borró— no trae ruta, así que no hay nada que firmar. Pedir una
 * firma de una ruta vacía sería una petición garantizada a fallar por cada
 * mensaje viejo del historial, que pasado un día son casi todos.
 *
 * Si la firma falla, el mensaje se devuelve igual: la cinta se ve sin foto y el
 * texto se lee entero. Quedarse sin miniatura no puede dejar sin chat.
 */
async function conMiniaturasDeHistoria(mensajes: Message[]): Promise<Message[]> {
  const rutas = mensajes
    .map((m) => m.storyContext?.mediaPath)
    .filter((ruta): ruta is string => !!ruta);
  if (rutas.length === 0) return mensajes;

  let firmas: Record<string, string> = {};
  try {
    firmas = await signMediaUrls(rutas);
  } catch {
    return mensajes;
  }

  return mensajes.map((mensaje) =>
    mensaje.storyContext?.mediaPath
      ? {
          ...mensaje,
          storyContext: {
            ...mensaje.storyContext,
            mediaUrl: firmas[mensaje.storyContext.mediaPath],
          },
        }
      : mensaje,
  );
}

/**
 * Las dos cosas juntas, que es como las necesita toda pantalla de chat.
 *
 * Exportada para los temas de un grupo (`TemasRepository`): sus mensajes son
 * mensajes de chat y se firman igual, todos de una vez.
 */
export async function completar(mensajes: Message[]): Promise<Message[]> {
  return conMiniaturasDeHistoria(await conUrlsFirmadas(mensajes));
}

/**
 * Un mensaje tal como se enseña en una VISTA del chat (fotos, archivos, un
 * filtro del grupo…).
 *
 * ES EL MISMO MENSAJE del chat, con su mismo `id`. Lleva a su autor con nombre
 * —y no el «mío / suyo» de `Message`— porque en una vista los mensajes salen
 * fuera de su conversación, uno debajo de otro, y hay que decir de quién es
 * cada uno.
 */
export type MensajeDeVista = {
  id: string;
  texto: string;
  fechaIso: string;
  mio: boolean;
  autor: { id: string; nombre: string; avatarUrl?: string };
  adjuntos: MessageAttachment[];
  /** Los temas en los que está (solo en General de una comunidad con temas). */
  temas: TemaDeMensaje[];
};

export type PaginaDeVista = {
  mensajes: MensajeDeVista[];
  /** `null` cuando no hay más páginas. */
  siguiente: CursorDeVista | null;
};

/** Lo que el servidor dice que se puede hacer en esta instalación. */
export type FuncionesDelChat = {
  /** Se pueden mandar notas de voz (migración 0044 aplicada). */
  notasDeVoz: boolean;
  /** Se guarda la referencia a la historia respondida. */
  respuestasAHistorias: boolean;
  /** Se puede reaccionar a un mensaje y responder a uno concreto (0106). */
  reacciones: boolean;
  /** Se puede silenciar una conversación y vaciarla para uno mismo (0107). */
  preferencias: boolean;
  /** El servidor dice quién leyó cada mensaje: la confirmación de lectura. */
  lecturas: boolean;
  /**
   * Se les puede poner nombre a los adjuntos (`attachment_titles`, migración
   * 0113). Sin ella no se ofrece ningún campo de nombre ni «Ponerle nombre»,
   * y un archivo de audio se manda como documento, igual que antes: una API
   * anterior rechaza un audio sin duración.
   */
  nombres: boolean;
};

/*
  `/conversations/availability`, UNA PREGUNTA CADA POCO (28/10/2026).

  Lo preguntaban por separado `funciones()` y `TemasRepository.disponibilidad()`
  —abrir un grupo eran dos peticiones iguales— y lo volvía a preguntar cada
  chat, tema o grupo al abrirse (auditoría del 27/10, §6.4). Describe la
  instalación, no a quien mira, y solo cambia con un despliegue: la pregunta
  se comparte y la respuesta vale diez minutos, que bastan para enterarse de
  una función nueva sin reiniciar la aplicación. Un fallo no se recuerda.
*/
const DISPONIBILIDAD_DURA_MS = 10 * 60_000;

/** Lo que dice el servidor de las funciones del chat, compartido (ver arriba). */
export const leerDisponibilidadDelChat = respuestaCompartida(
  () => apiRequest<Record<string, unknown> | null>(`${API_V1}/conversations/availability`),
  DISPONIBILIDAD_DURA_MS,
);

/** Lo que se da por hecho mientras el servidor no contesta: nada. */
export const SIN_FUNCIONES: FuncionesDelChat = {
  notasDeVoz: false,
  respuestasAHistorias: false,
  reacciones: false,
  preferencias: false,
  lecturas: false,
  nombres: false,
};

export const MessageRepository = {
  /**
   * Qué funciones del chat existen HOY en el servidor. NUNCA UN BOTON MUERTO.
   *
   * Se pregunta antes de pintar el micrófono. Sin esto, la única forma de saber
   * si se puede mandar una nota de voz sería grabarla, subirla y recibir un 503:
   * el botón parecería funcionar, alguien hablaría treinta segundos y lo
   * perdería todo.
   *
   * UN FALLO DE RED TAMBIEN RESPONDE `false`, igual que en `ReviewRepository`:
   * es preferible no ofrecer algo que quizá no funcione a ofrecerlo y perder lo
   * que alguien acaba de grabar. Y lo mismo con una API antigua que no conozca
   * la ruta: `?? false` y no `!== false`.
   */
  async funciones(): Promise<FuncionesDelChat> {
    try {
      const dto = ((await leerDisponibilidadDelChat()) ?? {}) as {
        voice_notes?: boolean;
        story_replies?: boolean;
        reactions?: boolean;
        preferences?: boolean;
        read_receipts?: boolean;
        attachment_titles?: boolean;
      };
      return {
        notasDeVoz: dto.voice_notes === true,
        respuestasAHistorias: dto.story_replies === true,
        reacciones: dto.reactions === true,
        preferencias: dto.preferences === true,
        lecturas: dto.read_receipts === true,
        nombres: dto.attachment_titles === true,
      };
    } catch {
      return SIN_FUNCIONES;
    }
  },

  /**
   * Silencia una conversación, o le devuelve los avisos. SOLO PARA QUIEN LO
   * PIDE: a los demás miembros no les cambia nada. Los mensajes siguen
   * llegando y contando como no leídos; lo que no llega es el aviso.
   */
  async silenciar(conversationId: string, silenciada: boolean): Promise<void> {
    await apiRequest<void>(`${API_V1}/conversations/${conversationId}/mute`, {
      method: silenciada ? 'PUT' : 'DELETE',
    });
  },

  /**
   * Vacía el chat PARA QUIEN LO PIDE. No borra ningún mensaje: los demás los
   * siguen viendo, y lo que llegue después se ve con normalidad.
   */
  async vaciar(conversationId: string): Promise<void> {
    await apiRequest<void>(`${API_V1}/conversations/${conversationId}/clear`, {
      method: 'POST',
    });
  },

  /**
   * Qué vistas tiene una conversación: cuántos mensajes hay de cada categoría
   * y, en un grupo, sus filtros.
   *
   * UN FALLO NO ROMPE NADA: devuelve `SIN_VISTAS`, que es «solo Todo». Vale
   * igual para una API antigua que no conozca la ruta.
   */
  async vistas(conversationId: string, signal?: AbortSignal): Promise<VistasDeChat> {
    try {
      return leerVistas(
        await apiRequest<unknown>(`${API_V1}/conversations/${conversationId}/views`, { signal }),
      );
    } catch {
      return SIN_VISTAS;
    }
  },

  /**
   * Una página de una vista, de lo más reciente a lo más antiguo.
   *
   * QUÉ MENSAJES ENTRAN LO DECIDE EL SERVIDOR. Aquí no se filtra nada: filtrar
   * lo ya descargado solo vería las páginas cargadas.
   *
   * `signal` deja cancelar la petición cuando se cambia de pestaña antes de
   * que conteste.
   */
  async mensajesDeVista(
    conversationId: string,
    vista: VistaElegida,
    {
      buscar,
      cursor,
      signal,
      currentUserId,
      tema = FILTRO_DE_TEMA_TODOS,
    }: {
      buscar?: string;
      cursor?: CursorDeVista | null;
      signal?: AbortSignal;
      currentUserId?: string | null;
      /** La fila «Tema» de Contenido: todo, sin tema o un tema. */
      tema?: FiltroDeTema;
    } = {},
  ): Promise<PaginaDeVista> {
    const dto = await apiRequest<{ items?: MessageDto[] }>(
      `${API_V1}/conversations/${conversationId}/views/messages?${parametrosDeVista(vista, {
        buscar,
        cursor,
        tema,
      })}`,
      { signal },
    );
    const filas = Array.isArray(dto?.items) ? dto.items : [];
    // Todas las firmas de la página en UNA llamada, igual que en el chat.
    const rutas = filas.flatMap((fila) =>
      (fila.attachments ?? []).flatMap((a) =>
        rutasDeUnAdjunto({ storagePath: a.storage_path, kind: a.kind }),
      ),
    );
    let firmas: Record<string, string> = {};
    try {
      firmas = await firmarAdjuntos(rutas);
    } catch {
      // Sin firma el adjunto enseña su hueco; el mensaje se lee igual.
    }
    return {
      mensajes: filas.map((fila) => ({
        id: fila.id,
        texto: fila.body ?? '',
        fechaIso: fila.created_at,
        mio: !!currentUserId && fila.sender?.id === currentUserId,
        autor: {
          id: fila.sender?.id ?? '',
          nombre: fila.sender?.full_name ?? '',
          avatarUrl: profileImageUrl(fila.sender?.avatar_path) ?? undefined,
        },
        adjuntos: (fila.attachments ?? []).map((a) => conFirmas(toAttachment(a), firmas)),
        temas: leerTemasDeMensaje(fila.topics),
      })),
      siguiente: leerCursor(dto),
    };
  },

  /**
   * Las cuentas de la fila «Tema» de Contenido para una categoría: cuántos
   * no están en ningún tema y cuántos hay en cada uno.
   *
   * NUNCA LANZA: `null` es «sin fila», que es lo que toca con una API
   * anterior, fuera de General de una comunidad o si la red falla. Un filtro
   * que no se puede contar no se ofrece.
   */
  async temasDeVista(
    conversationId: string,
    categoria: Categoria,
    signal?: AbortSignal,
  ): Promise<CuentasDeTemas | null> {
    try {
      return leerCuentasDeTemas(
        await apiRequest<unknown>(
          `${API_V1}/conversations/${conversationId}/views/topics?category=${encodeURIComponent(categoria)}`,
          { signal },
        ),
      );
    } catch {
      return null;
    }
  },

  /**
   * Le pone nombre a un adjunto, se lo cambia o se lo quita (`null`).
   *
   * QUIÉN PUEDE lo decide el servidor: quien envió el mensaje y quien
   * administra la conversación, la misma regla que borrar. Una foto no lleva
   * nombre (422 `attachment_title_not_allowed`), y sin la 0113 responde 503
   * `attachment_titles_not_available`. Lanza: quien llama enseña el motivo.
   *
   * Devuelve el adjunto como queda, sin firmar: quien llama solo toma su
   * nombre, la dirección que ya tenía sigue valiendo.
   */
  async nombrarAdjunto(
    conversationId: string,
    messageId: string,
    attachmentId: string,
    titulo: string | null,
  ): Promise<MessageAttachment | null> {
    const dto = await apiRequest<AttachmentDto | null>(
      `${API_V1}/conversations/${conversationId}/messages/${messageId}/attachments/${attachmentId}`,
      { method: 'PATCH', body: JSON.stringify({ title: titulo }) },
    );
    return dto && typeof dto === 'object' && typeof dto.id === 'string' ? toAttachment(dto) : null;
  },

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
   *
   * BUSCAR Y FILTRAR VAN EN `consulta`, Y LOS RESUELVE EL SERVIDOR. Antes la
   * pantalla filtraba `nombre.includes(texto)` sobre las veinte filas que ya
   * tenía en memoria: buscar a la persona de la conversación número veinticinco
   * no la encontraba, y encima se desactivaba la paginación mientras hubiera
   * texto. Con doscientas conversaciones eso es mentirle a quien busca. Aquí van
   * `q`, `filtro` y `label_id`, y la paginación sigue funcionando sobre el
   * resultado filtrado porque `limit`/`offset` cuentan filas de verdad.
   *
   * Está medido que esto NO cuesta consultas de más en el servidor: la búsqueda
   * y los filtros derivados entran en la consulta que ya se hacía, y las
   * etiquetas de la página se resuelven con un `IN` sobre los identificadores.
   *
   * SIEMPRE AGRUPADA (`grouped=true`, temas y comunidades). Las comunidades no
   * salen sueltas: viven dentro de su grupo, como en Telegram (D12), y cada
   * grupo trae cuántos temas y comunidades tiene y lo que hay sin leer en
   * todo. Va aquí y no en `parametrosDeBandeja` porque no es algo que la
   * pantalla elija: es cómo pide la bandeja esta versión de la aplicación,
   * también el contador común, que tiene que contar lo mismo que se ve.
   */
  async listConversations({
    limit = CONVERSACIONES_POR_PAGINA,
    offset = 0,
    consulta = CONSULTA_VACIA,
  }: {
    limit?: number;
    offset?: number;
    consulta?: ConsultaDeBandeja;
  } = {}): Promise<Conversation[]> {
    const dtos = await apiRequest<ConversationDto[]>(
      `${API_V1}/conversations?${parametrosDeBandeja(consulta, { limit, offset })}&grouped=true`,
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
    return completar(dtos.map((d) => toMessage(d, currentUserId)));
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
    return completar(dtos.map((d) => toMessage(d, currentUserId)));
  },

  /**
   * Manda un mensaje: solo texto, solo archivos, o las dos cosas.
   *
   * Los archivos ya están SUBIDOS cuando se llega aquí (ver `messageMedia.ts`):
   * aquí solo viajan sus rutas. Es lo que permite mandar un vídeo grande por
   * trozos reanudables sin que la API sostenga la conexión mientras tanto.
   *
   * `storyId` ES LO QUE CONVIERTE EL MENSAJE EN UNA RESPUESTA A UNA HISTORIA.
   * Va como un campo aparte y NO pegado dentro de `body`: el cuerpo es lo que
   * la persona escribió, y meter ahí un enlace haría imposible distinguir una
   * respuesta de verdad de alguien que pegó una URL, además de dejar un enlace
   * muerto en mitad de la frase en cuanto la historia caducara.
   *
   * De quién es la historia lo resuelve el SERVIDOR leyendo la fila; aquí solo
   * viaja el identificador. Y que la historia ya no exista no tira el mensaje:
   * se manda igual, sin contexto.
   */
  async sendMessage(
    conversationId: string,
    body: string,
    currentUserId?: string | null,
    attachments: AdjuntoSubido[] = [],
    storyId?: string | null,
    /** El mensaje de esta conversación al que se responde, si se responde a uno. */
    replyToId?: string | null,
  ): Promise<Message> {
    const dto = await apiRequest<MessageDto>(
      `${API_V1}/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({
          body,
          attachments,
          ...(storyId ? { story_id: storyId } : {}),
          ...(replyToId ? { reply_to_id: replyToId } : {}),
        }),
      },
    );
    const [mensaje] = await completar([toMessage(dto, currentUserId)]);
    return mensaje ?? toMessage(dto, currentUserId);
  },

  /**
   * Borra un mensaje PROPIO, para todo el mundo.
   *
   * ES UN BORRADO SUAVE EN EL SERVIDOR, no una desaparición: la burbuja se
   * queda y pasa a decir «Mensaje eliminado». Que no desaparezca del todo es
   * deliberado — si se esfumara sin dejar hueco, quien está al otro lado habría
   * leído algo que de pronto no está y no sabría que se ha borrado.
   *
   * QUIÉN PUEDE lo decide el servidor: quien lo escribió, la moderación y, en
   * un grupo, quien lo administra (D4 de temas y comunidades); nadie más
   * (`message_not_yours`). Aquí solo se evita ofrecer la acción sobre un
   * mensaje ajeno a quien no administra, que es comodidad y no permiso.
   *
   * Es IDEMPOTENTE: borrar dos veces responde lo mismo y la marca conserva la
   * fecha del borrado de verdad.
   */
  async deleteMessage(conversationId: string, messageId: string): Promise<void> {
    await apiRequest<void>(
      `${API_V1}/conversations/${conversationId}/messages/${messageId}`,
      { method: 'DELETE' },
    );
  },

  /**
   * Pone la reacción de quien llama (o la quita, con `null`). Devuelve cómo
   * quedan las reacciones del mensaje según el servidor, que es quien sabe.
   */
  async reaccionar(
    conversationId: string,
    messageId: string,
    emoji: string | null,
  ): Promise<ReaccionDeMensaje[]> {
    return leerReacciones(
      await apiRequest<unknown>(
        `${API_V1}/conversations/${conversationId}/messages/${messageId}/reaction`,
        emoji ? { method: 'PUT', body: JSON.stringify({ emoji }) } : { method: 'DELETE' },
      ),
    );
  },

  /**
   * Las reacciones de unos mensajes concretos, en UNA petición.
   *
   * Una reacción cambia un mensaje antiguo, y el chat solo pide los nuevos:
   * cuando alguien reacciona, se pregunta aquí por los que hay a la vista.
   */
  async reaccionesDe(
    conversationId: string,
    messageIds: string[],
  ): Promise<Record<string, ReaccionDeMensaje[]>> {
    return leerConsultaDeReacciones(
      await apiRequest<unknown>(`${API_V1}/conversations/${conversationId}/reactions/lookup`, {
        method: 'POST',
        body: JSON.stringify({ message_ids: messageIds }),
      }),
    );
  },

  /**
   * Hasta dónde ha leído cada una de las OTRAS personas de la conversación.
   *
   * Con eso se pinta la marca de cada burbuja propia sin preguntar mensaje
   * por mensaje. Lanza si falla: quien llama decide quedarse con lo que tenía.
   */
  async marcasDeLectura(conversationId: string): Promise<MarcaDeLectura[]> {
    return leerMarcas(
      await apiRequest<unknown>(`${API_V1}/conversations/${conversationId}/read-state`),
    );
  },

  /**
   * Los detalles de un mensaje PROPIO: quién lo leyó y quién todavía no.
   *
   * `null` si el servidor contesta algo que no se entiende. De un mensaje
   * ajeno, borrado o de otra conversación el servidor responde 404.
   */
  async detallesDeMensaje(
    conversationId: string,
    messageId: string,
  ): Promise<DetallesDeMensaje | null> {
    return leerDetalles(
      await apiRequest<unknown>(
        `${API_V1}/conversations/${conversationId}/messages/${messageId}/receipts`,
      ),
    );
  },

  async markRead(conversationId: string): Promise<void> {
    await apiRequest<void>(`${API_V1}/conversations/${conversationId}/read`, {
      method: 'POST',
    });
  },
};
