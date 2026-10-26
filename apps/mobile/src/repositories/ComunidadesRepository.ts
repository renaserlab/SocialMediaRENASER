import { apiRequest, API_V1 } from '@/services/api';
import {
  leerComunidad,
  leerComunidades,
  type ComunidadDeGrupo,
  type ComunidadesDeGrupo,
  type EntradaDeComunidad,
} from '@/lib/temasDeGrupo';
import { GroupRepository } from '@/repositories/GroupRepository';

/**
 * Las COMUNIDADES de un grupo (migración 0109, `messaging/subgrupos.py`).
 *
 * QUÉ ES UNA COMUNIDAD. Un grupo hijo, con su chat, su historial y sus
 * miembros. Estar en el grupo NO mete en ninguna: cada persona entra en las que
 * quiere, con un toque si es abierta o pidiéndolo si no (D2). Quien entra ve
 * todo su historial (D1).
 *
 * EN EL CÓDIGO SE LLAMAN `subgroups` porque `communities` ya son los círculos
 * de Explorar. En la pantalla se llaman «Comunidades», y su padre, «grupo».
 *
 * SE REUTILIZA LO QUE YA EXISTE. Una comunidad es un grupo normal: su chat es
 * `/chat/[id]`, pedir entrar y retirar la solicitud son las rutas de
 * `join-requests`, y salir es quitarse de sus miembros. Aquí solo está lo que
 * cuelga del grupo padre: listar, crear, cambiar, eliminar y unirse.
 *
 * SIN LA 0109 NO SE ROMPE NADA: listar responde `available: false` y las
 * escrituras 503 `subgroups_unavailable`. La pantalla no ofrece la sección.
 */

const base = (grupoId: string) => `${API_V1}/conversations/${grupoId}/subgroups`;

export const ComunidadesRepository = {
  /**
   * Las comunidades vivas de un grupo, con lo que le toca ver a quien pregunta.
   *
   * LANZA si falla la red: un fallo no es «no hay comunidades», y decirlo
   * haría creer que se borraron.
   */
  async listar(grupoId: string, signal?: AbortSignal): Promise<ComunidadesDeGrupo> {
    return leerComunidades(await apiRequest<unknown>(base(grupoId), { signal }));
  },

  /**
   * Crea una comunidad. Dentro queda solo quien administra; los demás entran
   * cuando quieran.
   */
  async crear(
    grupoId: string,
    { titulo, descripcion, entrada }: { titulo: string; descripcion?: string; entrada?: EntradaDeComunidad },
  ): Promise<ComunidadDeGrupo | null> {
    const cuerpo: Record<string, string> = { title: titulo };
    if (descripcion) cuerpo.description = descripcion;
    if (entrada) cuerpo.entry = entrada;
    return leerComunidad(
      await apiRequest<unknown>(base(grupoId), { method: 'POST', body: JSON.stringify(cuerpo) }),
      true,
    );
  },

  async cambiar(
    grupoId: string,
    comunidadId: string,
    cambios: { titulo?: string; descripcion?: string; entrada?: EntradaDeComunidad; posicion?: number },
  ): Promise<ComunidadDeGrupo | null> {
    const cuerpo: Record<string, unknown> = {};
    if (cambios.titulo !== undefined) cuerpo.title = cambios.titulo;
    if (cambios.descripcion !== undefined) cuerpo.description = cambios.descripcion;
    if (cambios.entrada !== undefined) cuerpo.entry = cambios.entrada;
    if (cambios.posicion !== undefined) cuerpo.position = cambios.posicion;
    return leerComunidad(
      await apiRequest<unknown>(`${base(grupoId)}/${comunidadId}`, {
        method: 'PATCH',
        body: JSON.stringify(cuerpo),
      }),
      true,
    );
  },

  /**
   * Elimina la comunidad (D5), por si se creó por error. Se quitan todos sus
   * miembros; sus mensajes se quedan en la base, inaccesibles.
   */
  async eliminar(grupoId: string, comunidadId: string): Promise<void> {
    await apiRequest<void>(`${base(grupoId)}/${comunidadId}`, { method: 'DELETE' });
  },

  /**
   * Entrar en una comunidad ABIERTA. En una con solicitud el servidor responde
   * 409 `subgroup_requires_request`: hay que usar `pedir`.
   */
  async unirme(grupoId: string, comunidadId: string): Promise<void> {
    await apiRequest<void>(`${base(grupoId)}/${comunidadId}/join`, { method: 'POST' });
  },

  /**
   * Pedir entrar. Es la ruta de solicitudes de siempre: ser miembro del grupo
   * padre basta para llegar a ella, sin enlace ni perfil.
   */
  async pedir(comunidadId: string): Promise<void> {
    await GroupRepository.pedirEntrar(comunidadId);
  },

  async retirar(comunidadId: string): Promise<void> {
    await GroupRepository.retirarSolicitud(comunidadId);
  },
};
