import { apiRequest, API_V1 } from '@/services/api';
import { ConversationDto, toConversation } from '@/mappers/messageMapper';
import {
  leerAjustes,
  leerInfo,
  leerSolicitudes,
  leerTarjeta,
  leerTarjetas,
  type AjustesDeGrupo,
  type InfoDeConversacion,
  type SolicitudDeGrupo,
  type TarjetaDeGrupo,
} from '@/lib/gruposDeChat';
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

  // -------------------------------------------------------------------------
  // Entrar a un grupo: foto, enlace, tarjetas y solicitudes
  // -------------------------------------------------------------------------

  /**
   * «Únete a mi grupo»: los grupos que una persona enseña en su perfil.
   *
   * NUNCA LANZA: sin respuesta, la sección del perfil no se pinta. Un perfil
   * no puede dejar de verse porque falle esta lista.
   */
  async tarjetasDe(personaId: string): Promise<TarjetaDeGrupo[]> {
    try {
      return leerTarjetas(
        await apiRequest<unknown>(`${API_V1}/conversations/groups/of/${personaId}`),
      );
    } catch {
      return [];
    }
  },

  /** La tarjeta del grupo de un enlace. Lanza si el enlace no vale (404). */
  async tarjetaDelEnlace(codigo: string): Promise<TarjetaDeGrupo | null> {
    return leerTarjeta(
      await apiRequest<unknown>(
        `${API_V1}/conversations/groups/invite/${encodeURIComponent(codigo)}`,
      ),
    );
  },

  /**
   * Pide entrar. NO mete en el grupo: deja la solicitud a quien lo administra.
   * `codigo` es el del enlace, cuando se llegó por él.
   */
  async pedirEntrar(conversationId: string, codigo?: string | null): Promise<void> {
    await apiRequest<unknown>(`${API_V1}/conversations/${conversationId}/join-requests`, {
      method: 'POST',
      body: JSON.stringify(codigo ? { code: codigo } : {}),
    });
  },

  async retirarSolicitud(conversationId: string): Promise<void> {
    await apiRequest<void>(`${API_V1}/conversations/${conversationId}/join-requests/mine`, {
      method: 'DELETE',
    });
  },

  /** Quién espera respuesta. Solo para quien administra el grupo. */
  async solicitudes(conversationId: string): Promise<SolicitudDeGrupo[]> {
    return leerSolicitudes(
      await apiRequest<unknown>(`${API_V1}/conversations/${conversationId}/join-requests`),
    );
  },

  async responderSolicitud(
    conversationId: string,
    solicitudId: string,
    aceptar: boolean,
  ): Promise<void> {
    await apiRequest<void>(
      `${API_V1}/conversations/${conversationId}/join-requests/${solicitudId}/${
        aceptar ? 'approve' : 'reject'
      }`,
      { method: 'POST' },
    );
  },

  /** Enseñar el grupo en el perfil y activar su enlace. Devuelve cómo queda. */
  async cambiarAjustes(
    conversationId: string,
    cambios: { enMiPerfil?: boolean; enlaceActivo?: boolean },
  ): Promise<AjustesDeGrupo> {
    const cuerpo: Record<string, boolean> = {};
    if (cambios.enMiPerfil !== undefined) cuerpo.listed_on_profile = cambios.enMiPerfil;
    if (cambios.enlaceActivo !== undefined) cuerpo.invite_enabled = cambios.enlaceActivo;
    return leerAjustes(
      await apiRequest<unknown>(`${API_V1}/conversations/${conversationId}/group/settings`, {
        method: 'PATCH',
        body: JSON.stringify(cuerpo),
      }),
    );
  },

  /** Cambia el enlace: el anterior deja de valer en el acto. */
  async cambiarEnlace(conversationId: string): Promise<AjustesDeGrupo> {
    return leerAjustes(
      await apiRequest<unknown>(
        `${API_V1}/conversations/${conversationId}/group/invite/rotate`,
        { method: 'POST' },
      ),
    );
  },

  /** Pone la foto. Los bytes ya están subidos: aquí va la ruta. */
  async ponerFoto(conversationId: string, ruta: string): Promise<void> {
    await apiRequest<void>(`${API_V1}/conversations/${conversationId}/group/photo`, {
      method: 'PUT',
      body: JSON.stringify({ avatar_path: ruta }),
    });
  },

  async quitarFoto(conversationId: string): Promise<void> {
    await apiRequest<void>(`${API_V1}/conversations/${conversationId}/group/photo`, {
      method: 'DELETE',
    });
  },
};
