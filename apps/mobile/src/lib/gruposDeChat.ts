/**
 * Grupos de mensajería: lo que se decide sin pantalla y sin red.
 *
 * Leer lo que manda el servidor sin romperse, saber de quién es cada mensaje
 * en un grupo, y decir antes de enviar lo que el servidor rechazaría.
 *
 * LOS PERMISOS NO ESTÁN AQUÍ. `puedoAdministrar` solo sirve para no pintar
 * botones que responderían 403; quién puede cambiar un grupo lo decide el
 * servidor en cada petición (`messaging/grupos.py`).
 *
 * Sin importaciones, a propósito: se prueba con `node --test` tal cual.
 */

/** Los mismos números que `messaging/grupos.py`, que es quien manda. */
export const MAX_TITULO_DE_GRUPO = 60;
export const MAX_MIEMBROS_DE_GRUPO = 100;
export const MAX_PERSONAS_POR_TANDA = 50;

export type MiembroDeGrupo = {
  id: string;
  nombre: string;
  usuario?: string;
  avatarPath?: string;
  /** Administra el grupo. En un chat de dos, nadie. */
  administra: boolean;
};

export type InfoDeConversacion = {
  id: string;
  esGrupo: boolean;
  titulo: string;
  puedoAdministrar: boolean;
  miembros: MiembroDeGrupo[];
  maximoDeMiembros: number;
};

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function leerMiembro(bruto: unknown): MiembroDeGrupo | null {
  if (!esObjeto(bruto) || typeof bruto.id !== 'string' || !bruto.id) return null;
  const nombre = typeof bruto.full_name === 'string' ? bruto.full_name.trim() : '';
  const usuario = typeof bruto.username === 'string' && bruto.username ? bruto.username : undefined;
  return {
    id: bruto.id,
    // Sin nombre se enseña el usuario: una fila en blanco no dice quién es.
    nombre: nombre || usuario || '',
    usuario,
    avatarPath:
      typeof bruto.avatar_path === 'string' && bruto.avatar_path ? bruto.avatar_path : undefined,
    administra: bruto.is_admin === true,
  };
}

/**
 * Lo que dice `GET /conversations/{id}/info`. `null` si no se entiende.
 *
 * `null` significa «no se sabe qué es esta conversación», y la pantalla la
 * trata entonces como siempre: un chat de dos. Vale igual para un servidor
 * antiguo que no conozca la ruta.
 */
export function leerInfo(bruto: unknown): InfoDeConversacion | null {
  if (!esObjeto(bruto) || typeof bruto.id !== 'string' || typeof bruto.kind !== 'string') {
    return null;
  }
  const esGrupo = bruto.kind === 'group';
  const miembros = Array.isArray(bruto.members)
    ? bruto.members.map(leerMiembro).filter((m): m is MiembroDeGrupo => m !== null)
    : [];
  return {
    id: bruto.id,
    esGrupo,
    titulo: typeof bruto.title === 'string' ? bruto.title.trim() : '',
    // Solo en un grupo: en un chat de dos no hay nada que administrar.
    puedoAdministrar: esGrupo && bruto.can_manage === true,
    miembros,
    maximoDeMiembros:
      typeof bruto.max_members === 'number' && bruto.max_members > 0
        ? bruto.max_members
        : MAX_MIEMBROS_DE_GRUPO,
  };
}

/**
 * Cómo se llama quien escribió un mensaje de un grupo.
 *
 * Primero lo que dice la lista de miembros —que es lo más reciente—, después
 * el nombre que traía el propio mensaje. Quien ya salió del grupo no está en
 * la lista, pero sus mensajes siguen y traen su nombre.
 */
export function nombreDelAutor(
  info: InfoDeConversacion | null | undefined,
  autorId: string | undefined,
  nombreEnElMensaje?: string,
): string {
  if (autorId) {
    const miembro = info?.miembros.find((m) => m.id === autorId);
    if (miembro?.nombre) return miembro.nombre;
  }
  return (nombreEnElMensaje ?? '').trim();
}

/** El título tal como se guardará: sin espacios de más. */
export function limpiarTitulo(texto: string): string {
  return texto.split(/\s+/).filter(Boolean).join(' ');
}

export type JuicioDeTitulo = 'vale' | 'vacio' | 'largo';

export function juzgarTitulo(texto: string): JuicioDeTitulo {
  const limpio = limpiarTitulo(texto);
  if (!limpio) return 'vacio';
  return limpio.length > MAX_TITULO_DE_GRUPO ? 'largo' : 'vale';
}

export type JuicioDeGrupoNuevo = JuicioDeTitulo | 'sin_personas' | 'demasiadas';

/** Si se puede mandar ya la creación de un grupo. */
export function juzgarGrupoNuevo(titulo: string, personas: number): JuicioDeGrupoNuevo {
  const delTitulo = juzgarTitulo(titulo);
  if (delTitulo !== 'vale') return delTitulo;
  if (personas < 1) return 'sin_personas';
  return personas > MAX_PERSONAS_POR_TANDA ? 'demasiadas' : 'vale';
}

/**
 * La clave del texto que explica un rechazo del servidor.
 *
 * Los códigos son los de `grupos.py` y `vistas.py`. Uno que no se conozca cae
 * en el genérico: mejor «no se pudo» que un código en la cara de alguien.
 */
export function claveDelFalloDeGrupo(codigo: string | null | undefined): string {
  switch (codigo) {
    case 'group_member_not_allowed':
      return 'groups.errorMemberNotAllowed';
    case 'group_is_full':
      return 'groups.errorFull';
    case 'group_rate_limited':
      return 'groups.errorRateLimited';
    case 'group_admin_required':
    case 'filters_not_allowed':
      return 'groups.errorAdminRequired';
    case 'group_admin_cannot_leave':
      return 'groups.errorAdminCannotLeave';
    case 'group_needs_members':
      return 'groups.errorNeedsMembers';
    case 'group_member_not_found':
      return 'groups.errorMemberGone';
    case 'filter_name_taken':
      return 'groupFilters.errorNameTaken';
    case 'filters_limit_reached':
      return 'groupFilters.errorLimit';
    case 'filter_author_not_member':
      return 'groupFilters.errorAuthor';
    case 'conversation_filters_not_available':
      return 'groupFilters.errorNotAvailable';
    case 'filter_not_found':
      return 'groupFilters.errorGone';
    default:
      return 'groups.errorGeneric';
  }
}
