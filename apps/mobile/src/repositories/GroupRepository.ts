import { apiRequest, API_V1 } from '@/services/api';
import { ConversationDto, toConversation } from '@/mappers/messageMapper';
import { leerInfo, type InfoDeConversacion } from '@/lib/gruposDeChat';
import { cuerpoDeFiltro, type BorradorDeFiltro } from '@/lib/vistasDeChat';
import type { Conversation } from '@/types';

/**
 * Los grupos de mensajería y sus filtros.
 *
 * TODO PASA POR LA API. Quién puede cambiar un grupo —su nombre, sus miembros,
 * sus filtros— lo decide el servidor en cada petición; lo que la pantalla
 * esconde o enseña es comodidad. Un rechazo llega como `ApiError` con su
 * código, y la pantalla lo traduce con `claveDelFalloDeGrupo`.
 */
export const GroupRepository = {
  /** Crea un grupo con quien llama y las personas elegidas. */
  async crear(titulo: string, personas: string[]): Promise<Conversation> {
    const dto = await apiRequest<ConversationDto>(`${API_V1}/conversations/groups`, {
      method: 'POST',
      body: JSON.stringify({ title: titulo, member_ids: personas }),
    });
    return toConversation(dto);
  },

  /**
   * Qué es una conversación y quién está en ella. `null` si no se sabe.
   *
   * NUNCA LANZA: sin esta respuesta el chat se pinta como siempre, de dos
   * personas. Vale igual para un servidor antiguo que no conozca la ruta.
   */
  async info(conversationId: string): Promise<InfoDeConversacion | null> {
    try {
      return leerInfo(
        await apiRequest<unknown>(`${API_V1}/conversations/${conversationId}/info`),
      );
    } catch {
      return null;
    }
  },

  async renombrar(conversationId: string, titulo: string): Promise<void> {
    await apiRequest<void>(`${API_V1}/conversations/${conversationId}/group`, {
      method: 'PATCH',
      body: JSON.stringify({ title: titulo }),
    });
  },

  /** Añade personas y devuelve el grupo como queda. */
  async anadir(conversationId: string, personas: string[]): Promise<InfoDeConversacion | null> {
    return leerInfo(
      await apiRequest<unknown>(`${API_V1}/conversations/${conversationId}/members`, {
        method: 'POST',
        body: JSON.stringify({ user_ids: personas }),
      }),
    );
  },

  /** Saca a alguien del grupo; con el propio identificador, es salirse. */
  async quitar(conversationId: string, personaId: string): Promise<void> {
    await apiRequest<void>(
      `${API_V1}/conversations/${conversationId}/members/${personaId}`,
      { method: 'DELETE' },
    );
  },

  async crearFiltro(conversationId: string, borrador: BorradorDeFiltro): Promise<void> {
    await apiRequest<unknown>(`${API_V1}/conversations/${conversationId}/filters`, {
      method: 'POST',
      body: JSON.stringify(cuerpoDeFiltro(borrador)),
    });
  },

  async cambiarFiltro(
    conversationId: string,
    filtroId: string,
    borrador: BorradorDeFiltro,
  ): Promise<void> {
    await apiRequest<unknown>(
      `${API_V1}/conversations/${conversationId}/filters/${filtroId}`,
      { method: 'PATCH', body: JSON.stringify(cuerpoDeFiltro(borrador)) },
    );
  },

  /** Enciende o apaga un filtro sin tocar nada más de él. */
  async encenderFiltro(conversationId: string, filtroId: string, activo: boolean): Promise<void> {
    await apiRequest<unknown>(
      `${API_V1}/conversations/${conversationId}/filters/${filtroId}`,
      { method: 'PATCH', body: JSON.stringify({ enabled: activo }) },
    );
  },

  /** Borra la definición del filtro. Los mensajes no se tocan. */
  async borrarFiltro(conversationId: string, filtroId: string): Promise<void> {
    await apiRequest<void>(
      `${API_V1}/conversations/${conversationId}/filters/${filtroId}`,
      { method: 'DELETE' },
    );
  },
};
