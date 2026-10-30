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

/**
 * Cómo se entra a un grupo de primer nivel (en pantalla, una «comunidad»).
 * `open`: con un toque, desde el perfil o el enlace. `request`: se pide y
 * decide quien lo administra. Los mismos valores que manda la API (0114).
 */
export type EntradaDeGrupo = 'open' | 'request';

/** Cómo está configurada la entrada a un grupo. Solo lo recibe quien lo administra. */
export type AjustesDeGrupo = {
  /** Sale en «Únete a mi grupo», en el perfil de quien lo administra. */
  enMiPerfil: boolean;
  enlaceActivo: boolean;
  /** El código del enlace; `null` hasta que se activa por primera vez. */
  codigo: string | null;
  /**
   * Cómo se entra. `null` si el servidor no lo dice: es anterior a la 0114 y
   * no sabe cambiarlo, así que la pantalla no ofrece un ajuste que no haría nada.
   */
  entrada: EntradaDeGrupo | null;
};

export type InfoDeConversacion = {
  id: string;
  esGrupo: boolean;
  titulo: string;
  puedoAdministrar: boolean;
  miembros: MiembroDeGrupo[];
  maximoDeMiembros: number;
  /** La foto del grupo: una ruta del almacenamiento, como la de un perfil. */
  avatarPath?: string;
  /** El servidor conoce la foto, el enlace y las solicitudes (migración 0104). */
  hayExtras: boolean;
  /** Solo para quien administra; a los demás, `null`. */
  ajustes: AjustesDeGrupo | null;
  /** Solicitudes que esperan respuesta. Cero para quien no administra. */
  pendientes: number;
  /** Quien mira la tiene silenciada: no recibe sus avisos. Es suyo. */
  silenciada: boolean;
  /**
   * Si es una COMUNIDAD de un grupo: el grupo del que cuelga. `null` en un
   * grupo normal y con un servidor anterior a la 0109.
   */
  padre: { id: string; titulo: string } | null;
  /**
   * Si es el chat de un TEMA: de qué grupo y qué tema. Sirve para que un aviso
   * que abre la conversación suelta lleve al tema, que es donde se lee.
   */
  tema: { grupoId: string; temaId: string; nombre: string } | null;
};

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** El `parent` de `/info`. A medias no sirve: sin identificador no se puede ir a él. */
function leerPadre(bruto: unknown): InfoDeConversacion['padre'] {
  if (!esObjeto(bruto) || typeof bruto.id !== 'string' || !bruto.id) return null;
  return { id: bruto.id, titulo: typeof bruto.title === 'string' ? bruto.title.trim() : '' };
}

/** El `topic` de `/info`. Sin el grupo o sin el tema no hay a dónde llevar. */
function leerTemaDelChat(bruto: unknown): InfoDeConversacion['tema'] {
  if (!esObjeto(bruto)) return null;
  const grupoId = typeof bruto.group_id === 'string' ? bruto.group_id : '';
  const temaId = typeof bruto.topic_id === 'string' ? bruto.topic_id : '';
  if (!grupoId || !temaId) return null;
  return { grupoId, temaId, nombre: typeof bruto.name === 'string' ? bruto.name.trim() : '' };
}

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

/** Los ajustes de entrada, leídos sin fiarse de nada. Lo que falta, apagado. */
export function leerAjustes(bruto: unknown): AjustesDeGrupo {
  const b = esObjeto(bruto) ? bruto : {};
  const codigo = typeof b.invite_code === 'string' && b.invite_code ? b.invite_code : null;
  return {
    enMiPerfil: b.listed_on_profile === true,
    // Un enlace «activo» sin código no se puede compartir: es como apagado.
    enlaceActivo: b.invite_enabled === true && codigo !== null,
    codigo,
    entrada: b.entrada === 'open' || b.entrada === 'request' ? b.entrada : null,
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
  const puedoAdministrar = esGrupo && bruto.can_manage === true;
  const hayExtras = esGrupo && bruto.extras_available === true;
  return {
    id: bruto.id,
    esGrupo,
    titulo: typeof bruto.title === 'string' ? bruto.title.trim() : '',
    // Solo en un grupo: en un chat de dos no hay nada que administrar.
    puedoAdministrar,
    miembros,
    avatarPath:
      typeof bruto.avatar_path === 'string' && bruto.avatar_path ? bruto.avatar_path : undefined,
    hayExtras,
    // Los ajustes llevan el código del enlace: solo se aceptan para quien
    // administra, diga lo que diga la respuesta.
    ajustes: puedoAdministrar && hayExtras ? leerAjustes(bruto.settings) : null,
    pendientes:
      puedoAdministrar && typeof bruto.pending_requests === 'number' && bruto.pending_requests > 0
        ? Math.floor(bruto.pending_requests)
        : 0,
    maximoDeMiembros:
      typeof bruto.max_members === 'number' && bruto.max_members > 0
        ? bruto.max_members
        : MAX_MIEMBROS_DE_GRUPO,
    silenciada: bruto.muted === true,
    // Solo un grupo puede ser comunidad de otro o chat de un tema.
    padre: esGrupo ? leerPadre(bruto.parent) : null,
    tema: esGrupo ? leerTemaDelChat(bruto.topic) : null,
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
export function claveDelFalloDeGrupo(
  codigo: string | null | undefined,
  /**
   * El rechazo es de un grupo que cuelga de otro (`info.padre`). En pantalla
   * el de primer nivel se llama «comunidad» y el de dentro «grupo», así que
   * los textos que lo nombran tienen dos versiones.
   */
  deDentro = false,
): string {
  switch (codigo) {
    case 'group_member_not_allowed':
      return 'groups.errorMemberNotAllowed';
    case 'group_is_full':
      return deDentro ? 'groupCommunities.errorFull' : 'groups.errorFull';
    case 'group_rate_limited':
      return 'groups.errorRateLimited';
    case 'group_admin_required':
      return deDentro ? 'groupCommunities.errorAdminRequired' : 'groups.errorAdminRequired';
    // Los filtros solo existen en el de primer nivel.
    case 'filters_not_allowed':
      return 'groups.errorAdminRequired';
    case 'group_admin_cannot_leave':
      return deDentro ? 'groupCommunities.errorAdminCannotLeave' : 'groups.errorAdminCannotLeave';
    case 'group_needs_members':
      return 'groups.errorNeedsMembers';
    case 'group_member_not_found':
      return deDentro ? 'groupCommunities.errorMemberGone' : 'groups.errorMemberGone';
    case 'group_not_found':
      return deDentro ? 'groupCommunities.errorGone' : 'groupJoin.errorNotFound';
    case 'group_requires_request':
      return 'groupJoin.errorNeedsRequest';
    case 'already_member':
      return deDentro ? 'groupCommunities.errorAlreadyMember' : 'groupJoin.errorAlreadyMember';
    case 'join_rate_limited':
      return 'groupJoin.errorRateLimited';
    case 'join_request_too_soon':
      return deDentro ? 'groupCommunities.errorTooSoon' : 'groupJoin.errorTooSoon';
    case 'join_request_not_found':
      return 'groupJoin.errorRequestGone';
    case 'group_extras_not_available':
      return 'groupJoin.errorNotAvailable';
    case 'group_photo_path_invalid':
      return 'groups.errorPhoto';
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

// ---------------------------------------------------------------------------
// Entrar a un grupo: la tarjeta y las solicitudes
// ---------------------------------------------------------------------------

/** Lo que ve de un grupo quien todavía no está dentro. */
export type TarjetaDeGrupo = {
  id: string;
  titulo: string;
  avatarPath?: string;
  miembros: number;
  administrador: { id: string; nombre: string };
  /** `miembro`: ya está dentro. `pendiente`: pidió entrar y espera respuesta. */
  miEstado: 'miembro' | 'pendiente' | 'ninguno';
  lleno: boolean;
  /** Cómo se entra. Un servidor anterior a la 0114 no lo dice: es con solicitud. */
  entrada: EntradaDeGrupo;
  /** Los grupos de dentro (en el código, subgrupos) que siguen vivos. */
  grupos: number;
  /** Los temas que siguen vivos. */
  temas: number;
};

/** Un recuento que manda el servidor: entero y sin negativos; lo demás, cero. */
const recuento = (v: unknown): number => (typeof v === 'number' && v > 0 ? Math.floor(v) : 0);

export function leerTarjeta(bruto: unknown): TarjetaDeGrupo | null {
  if (!esObjeto(bruto) || typeof bruto.id !== 'string' || !bruto.id) return null;
  const titulo = typeof bruto.title === 'string' ? bruto.title.trim() : '';
  const admin = esObjeto(bruto.admin) ? bruto.admin : null;
  if (!titulo || !admin || typeof admin.id !== 'string') return null;
  const nombre = typeof admin.full_name === 'string' ? admin.full_name.trim() : '';
  const usuario = typeof admin.username === 'string' ? admin.username : '';
  return {
    id: bruto.id,
    titulo,
    avatarPath:
      typeof bruto.avatar_path === 'string' && bruto.avatar_path ? bruto.avatar_path : undefined,
    miembros: recuento(bruto.members_count),
    administrador: { id: admin.id, nombre: nombre || usuario },
    miEstado:
      bruto.my_status === 'member'
        ? 'miembro'
        : bruto.my_status === 'pending'
          ? 'pendiente'
          : 'ninguno',
    lleno: bruto.is_full === true,
    // Lo que no sea `open` es con solicitud: es lo que vale por omisión, y lo
    // único que conoce un servidor anterior. Ofrecer «Unirme» donde solo se
    // puede pedir terminaría en un 409.
    entrada: bruto.entrada === 'open' ? 'open' : 'request',
    grupos: recuento(bruto.groups_count),
    temas: recuento(bruto.topics_count),
  };
}

/** Una lista de tarjetas; lo que no se entiende se deja fuera sin romper el resto. */
export function leerTarjetas(bruto: unknown): TarjetaDeGrupo[] {
  return Array.isArray(bruto)
    ? bruto.map(leerTarjeta).filter((t): t is TarjetaDeGrupo => t !== null)
    : [];
}

/**
 * Qué se ofrece en la tarjeta de un grupo a quien la mira.
 *
 * `unirme`: es abierto y se entra con un toque. `pedir`: es con solicitud y
 * puede pedir entrar. `esperando`: ya lo pidió (y puede retirarlo). `abrir`:
 * ya es miembro. `lleno`: no cabe nadie más, y no se ofrece ni entrar ni pedir.
 */
export type AccionDeTarjeta = 'unirme' | 'pedir' | 'esperando' | 'abrir' | 'lleno';

export function accionDeTarjeta(tarjeta: TarjetaDeGrupo): AccionDeTarjeta {
  if (tarjeta.miEstado === 'miembro') return 'abrir';
  // Una solicitud de cuando era con solicitud sigue siendo suya: se ve y se
  // puede retirar, aunque ahora sea abierto.
  if (tarjeta.miEstado === 'pendiente') return 'esperando';
  if (tarjeta.lleno) return 'lleno';
  return tarjeta.entrada === 'open' ? 'unirme' : 'pedir';
}

/** Un trozo del detalle de la tarjeta: la clave de su texto y, si cuenta algo, cuánto. */
export type TrozoDelDetalle = { clave: string; n?: number };

/**
 * «Comunidad abierta · 3 grupos · 4 temas»: cómo se entra y qué hay dentro.
 *
 * Lo que vale cero no se nombra: «0 grupos» no le dice nada a quien todavía
 * no ha entrado. Uno va en singular, con su propia clave.
 */
export function detalleDeTarjeta(
  tarjeta: Pick<TarjetaDeGrupo, 'entrada' | 'grupos' | 'temas'>,
): TrozoDelDetalle[] {
  const trozos: TrozoDelDetalle[] = [
    { clave: tarjeta.entrada === 'open' ? 'groupJoin.kindOpen' : 'groupJoin.kindRequest' },
  ];
  if (tarjeta.grupos > 0) {
    trozos.push(
      tarjeta.grupos === 1
        ? { clave: 'groupCommunities.countOne' }
        : { clave: 'groupCommunities.countMany', n: tarjeta.grupos },
    );
  }
  if (tarjeta.temas > 0) {
    trozos.push(
      tarjeta.temas === 1
        ? { clave: 'groupTopics.countOne' }
        : { clave: 'groupTopics.countMany', n: tarjeta.temas },
    );
  }
  return trozos;
}

/** Alguien que pidió entrar y espera respuesta. */
export type SolicitudDeGrupo = {
  id: string;
  persona: { id: string; nombre: string; usuario?: string; avatarPath?: string };
  /** `enlace`: llegó por el enlace del grupo. `perfil`: desde «Únete a mi grupo». */
  origen: 'enlace' | 'perfil';
};

export function leerSolicitudes(bruto: unknown): SolicitudDeGrupo[] {
  if (!Array.isArray(bruto)) return [];
  const salida: SolicitudDeGrupo[] = [];
  for (const fila of bruto) {
    if (!esObjeto(fila) || typeof fila.id !== 'string') continue;
    const persona = esObjeto(fila.user) ? fila.user : null;
    if (!persona || typeof persona.id !== 'string') continue;
    const nombre = typeof persona.full_name === 'string' ? persona.full_name.trim() : '';
    const usuario =
      typeof persona.username === 'string' && persona.username ? persona.username : undefined;
    salida.push({
      id: fila.id,
      persona: {
        id: persona.id,
        nombre: nombre || usuario || '',
        usuario,
        avatarPath:
          typeof persona.avatar_path === 'string' && persona.avatar_path
            ? persona.avatar_path
            : undefined,
      },
      origen: fila.source === 'link' ? 'enlace' : 'perfil',
    });
  }
  return salida;
}

/** El código de un enlace de grupo tiene esta forma; lo demás no se manda al servidor. */
export function esCodigoDeGrupo(texto: string | null | undefined): texto is string {
  return typeof texto === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(texto);
}

// ---------------------------------------------------------------------------
// Quién escribe, a simple vista
// ---------------------------------------------------------------------------

/** El miembro con ese identificador, si sigue en el grupo. */
export function miembroDe(
  info: InfoDeConversacion | null | undefined,
  autorId: string | undefined,
): MiembroDeGrupo | undefined {
  return autorId ? info?.miembros.find((m) => m.id === autorId) : undefined;
}

/**
 * Colores para el nombre de cada persona en un grupo, como en WhatsApp o
 * Telegram: se reconoce a alguien por su color antes de leer su nombre.
 *
 * DOS JUEGOS, porque el nombre va sobre la burbuja ajena, que es casi blanca
 * en claro y casi negra en oscuro: tonos oscuros para el tema claro y claros
 * para el oscuro. Todos pasan de 4,5:1 sobre su fondo.
 */
const COLORES_EN_CLARO = [
  '#C92A2A', '#A61E4D', '#862E9C', '#5F3DC4', '#364FC7', '#1864AB',
  '#0B7285', '#087F5B', '#2B8A3E', '#5C940D', '#B35C00', '#D9480F',
] as const;
const COLORES_EN_OSCURO = [
  '#FF8787', '#F783AC', '#DA77F2', '#9775FA', '#748FFC', '#4DABF7',
  '#3BC9DB', '#38D9A9', '#69DB7C', '#A9E34B', '#FFD43B', '#FFA94D',
] as const;

/**
 * El color de una persona: SIEMPRE el mismo para el mismo identificador.
 *
 * Sale de sus letras, no del orden en que aparece: si dependiera del orden,
 * alguien cambiaría de color cada vez que entra o sale otra persona.
 */
export function colorDeAutor(autorId: string | undefined, temaOscuro: boolean): string {
  const colores = temaOscuro ? COLORES_EN_OSCURO : COLORES_EN_CLARO;
  let suma = 0;
  for (const letra of autorId ?? '') suma = (suma * 31 + letra.charCodeAt(0)) % 9973;
  return colores[suma % colores.length] ?? colores[0];
}
