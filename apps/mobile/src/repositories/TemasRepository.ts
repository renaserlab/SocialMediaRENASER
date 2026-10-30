import { apiRequest, API_V1 } from '@/services/api';
import { toMessage, type MessageDto } from '@/mappers/messageMapper';
import {
  MENSAJES_DE_TEMA_POR_PAGINA,
  leerDatosDeTema,
  leerPaginaDeTema,
  leerTema,
  leerTemas,
  type DatosDeTema,
  type IconoDeTema,
  type TemaDeGrupo,
  type TemasDeGrupo,
} from '@/lib/temasDeGrupo';
import {
  MAX_CONSULTA_DE_TEMAS,
  leerTemasDeMensajes,
  type TemaDeMensaje,
} from '@/lib/nombresDeAdjuntos';
import { completar, leerDisponibilidadDelChat } from '@/repositories/MessageRepository';
import type { Message } from '@/types';

/**
 * Los TEMAS de un grupo (migración 0108, `messaging/temas.py`).
 *
 * QUÉ ES UN TEMA. Una fila más en la lista del grupo que todos los miembros
 * leen sin unirse a nada. Dentro solo hay dos cosas: REFERENCIAS a mensajes de
 * General que la administración eligió —el mismo mensaje, no una copia— y
 * mensajes escritos SOLO en el tema, que tampoco escribe nadie más que la
 * administración y que no salen en General (D11).
 *
 * LO ESCRITO EN UN TEMA VIVE EN SU PROPIO CHAT (`chat_id`). Por eso escribir
 * ahí es `MessageRepository.sendMessage(chatId, …)` tal cual, y escuchar es
 * `subscribeToConversation(chatId)`: adjuntos, tiempo real, avisos y
 * reacciones funcionan sin nada nuevo.
 *
 * TODO PASA POR LA API. Quién puede crear, renombrar o borrar un tema lo decide
 * el servidor; lo que esconde la pantalla es comodidad.
 *
 * SIN LA 0108 NO SE ROMPE NADA: las lecturas responden `available: false` y la
 * lista vacía, y las escrituras 503 `topics_unavailable`. La pantalla no ofrece
 * la sección. Nunca un botón muerto.
 */

/**
 * Un mensaje tal como se lee en un tema: un mensaje de chat con lo que el tema
 * añade (si es propio, quién lo agregó, el orden del tema).
 *
 * `conversacionId` es el de VERDAD —General o el chat del tema—, y es con el
 * que se reacciona y se borra.
 */
export type MensajeDeTema = Message & DatosDeTema;

export type PaginaDeTema = {
  mensajes: MensajeDeTema[];
  /** Queda algo más atrás: se puede pedir con `before`. */
  hayMas: boolean;
};

/** Lo que dice `/availability` de esta función. Sin respuesta, nada. */
export type DisponibilidadDeTemas = { temas: boolean; comunidades: boolean };

export const SIN_DISPONIBILIDAD: DisponibilidadDeTemas = { temas: false, comunidades: false };

const base = (grupoId: string) => `${API_V1}/conversations/${grupoId}/topics`;

/** Cuántos mensajes acepta de una vez el `PUT` por lotes (contrato §2). */
export const MAX_MENSAJES_POR_LOTE = 50;

export const TemasRepository = {
  /**
   * Si el servidor sabe de temas y de comunidades. NUNCA LANZA.
   *
   * Es lo que decide si el chat ofrece «Agregar a un tema»: preguntar antes es
   * lo que evita un botón que respondería 503. Un fallo de red o un servidor
   * antiguo responden que no, como `MessageRepository.funciones`. Es la misma
   * respuesta que la de las funciones del chat, así que se comparte con ella
   * (`leerDisponibilidadDelChat`).
   */
  async disponibilidad(): Promise<DisponibilidadDeTemas> {
    try {
      const dto = (await leerDisponibilidadDelChat()) as { topics?: boolean; subgroups?: boolean } | null;
      return { temas: dto?.topics === true, comunidades: dto?.subgroups === true };
    } catch {
      return SIN_DISPONIBILIDAD;
    }
  },

  /**
   * Los temas de un grupo, en el orden del servidor.
   *
   * Con `mensajeId`, cada tema dice si ya contiene ese mensaje: es lo que pinta
   * las casillas de «Agregar a un tema».
   *
   * LANZA si falla la red: quien llama decide si se queda con lo que tenía. No
   * se traduce un fallo en «no hay temas», que sería decir que se borraron.
   */
  async listar(
    grupoId: string,
    { mensajeId, signal }: { mensajeId?: string; signal?: AbortSignal } = {},
  ): Promise<TemasDeGrupo> {
    const consulta = mensajeId ? `?message_id=${encodeURIComponent(mensajeId)}` : '';
    return leerTemas(await apiRequest<unknown>(`${base(grupoId)}${consulta}`, { signal }));
  },

  /** Crea un tema. Su chat propio nace con todos los miembros del grupo dentro. */
  async crear(grupoId: string, nombre: string, icono?: IconoDeTema): Promise<TemaDeGrupo | null> {
    return leerTema(
      await apiRequest<unknown>(base(grupoId), {
        method: 'POST',
        body: JSON.stringify(icono ? { name: nombre, icon: icono } : { name: nombre }),
      }),
    );
  },

  /** Cambia el nombre, el icono o el sitio. Renombrar cambia también su chat. */
  async cambiar(
    grupoId: string,
    temaId: string,
    cambios: { nombre?: string; icono?: IconoDeTema; posicion?: number },
  ): Promise<TemaDeGrupo | null> {
    const cuerpo: Record<string, unknown> = {};
    if (cambios.nombre !== undefined) cuerpo.name = cambios.nombre;
    if (cambios.icono !== undefined) cuerpo.icon = cambios.icono;
    if (cambios.posicion !== undefined) cuerpo.position = cambios.posicion;
    return leerTema(
      await apiRequest<unknown>(`${base(grupoId)}/${temaId}`, {
        method: 'PATCH',
        body: JSON.stringify(cuerpo),
      }),
    );
  },

  /**
   * Elimina el tema (D15): sale de la lista para todos y lo escrito SOLO en él
   * se borra también (borrado suave). Las referencias no tocan General: esos
   * mensajes siguen allí.
   */
  async eliminar(grupoId: string, temaId: string): Promise<void> {
    await apiRequest<void>(`${base(grupoId)}/${temaId}`, { method: 'DELETE' });
  },

  /**
   * Una página de un tema, de lo más antiguo a lo más reciente.
   *
   * `before` es el `ordenIso` del más antiguo que ya se tiene: sube por el tema
   * aunque entre algo nuevo por abajo. Sin él, la página más reciente.
   *
   * Los adjuntos se firman TODOS en una llamada, como en el chat.
   */
  async mensajes(
    grupoId: string,
    temaId: string,
    currentUserId: string | null | undefined,
    {
      before,
      limit = MENSAJES_DE_TEMA_POR_PAGINA,
      signal,
    }: { before?: string | null; limit?: number; signal?: AbortSignal } = {},
  ): Promise<PaginaDeTema> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set('before', before);
    const { filas, hayMas } = leerPaginaDeTema(
      await apiRequest<unknown>(`${base(grupoId)}/${temaId}/messages?${params.toString()}`, {
        signal,
      }),
    );
    const datos = filas.map((fila) => leerDatosDeTema(fila) as DatosDeTema);
    const mensajes = await completar(
      filas.map((fila) => toMessage(fila as unknown as MessageDto, currentUserId)),
    );
    return {
      mensajes: mensajes.map((mensaje, i) => ({ ...mensaje, ...(datos[i] as DatosDeTema) })),
      hayMas,
    };
  },

  /**
   * «Ya lo vi»: el numerito del tema vuelve a cero para quien lo abre. Pone
   * también al día la lectura de su chat, así que no hace falta otro aviso.
   */
  async visto(grupoId: string, temaId: string): Promise<void> {
    await apiRequest<void>(`${base(grupoId)}/${temaId}/seen`, { method: 'POST' });
  },

  /**
   * Agrega un mensaje de General al tema. `PUT` porque es IDEMPOTENTE: dos
   * toques dejan lo mismo. No manda aviso a nadie (D9).
   */
  async agregar(grupoId: string, temaId: string, mensajeId: string): Promise<void> {
    await apiRequest<void>(`${base(grupoId)}/${temaId}/items/${mensajeId}`, { method: 'PUT' });
  },

  /** Lo quita del tema. El mensaje sigue en General. */
  async quitar(grupoId: string, temaId: string, mensajeId: string): Promise<void> {
    await apiRequest<void>(`${base(grupoId)}/${temaId}/items/${mensajeId}`, {
      method: 'DELETE',
    });
  },

  /**
   * Agrega de una vez varios mensajes de General a un tema (Contenido, «Agregar
   * N a un tema»). De 1 a 50, sin repetidos.
   *
   * TODO O NADA en el servidor: si alguno no es de General de esta comunidad
   * responde 404 `message_not_in_group` y no agrega ninguno, así que un fallo
   * nunca deja la selección a medias. Los que ya estaban no cuentan como
   * error (`already`).
   */
  async agregarVarios(
    grupoId: string,
    temaId: string,
    mensajeIds: readonly string[],
  ): Promise<{ agregados: number; yaEstaban: number }> {
    const ids = [...new Set(mensajeIds)].slice(0, MAX_MENSAJES_POR_LOTE);
    const dto = await apiRequest<{ added?: unknown; already?: unknown } | null>(
      `${base(grupoId)}/${temaId}/items`,
      { method: 'PUT', body: JSON.stringify({ message_ids: ids }) },
    );
    const cuenta = (v: unknown) => (typeof v === 'number' && v > 0 ? Math.floor(v) : 0);
    return { agregados: cuenta(dto?.added), yaEstaban: cuenta(dto?.already) };
  },

  /**
   * En qué temas está cada uno de unos mensajes de General, en UNA petición:
   * es como el chat refresca las etiquetas cuando alguien avisa por
   * `chat-temas` (contrato §3). Hasta cien; lo que no venga no está en ninguno.
   *
   * LANZA si falla: quien llama se queda con las etiquetas que tenía.
   */
  async temasDeMensajes(
    grupoId: string,
    mensajeIds: readonly string[],
  ): Promise<Record<string, TemaDeMensaje[]>> {
    const ids = [...new Set(mensajeIds)].slice(-MAX_CONSULTA_DE_TEMAS);
    if (ids.length === 0) return {};
    return leerTemasDeMensajes(
      await apiRequest<unknown>(
        `${base(grupoId)}/of-messages?ids=${ids.map(encodeURIComponent).join(',')}`,
      ),
    );
  },
};
