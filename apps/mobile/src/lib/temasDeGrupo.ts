/**
 * Temas y comunidades de un grupo: lo que se decide sin pantalla y sin red.
 *
 * Un grupo puede organizarse como en Telegram: al abrirlo sale una lista con
 * «General» (el chat de siempre), sus TEMAS —que todos leen sin unirse y solo
 * llena la administración— y sus COMUNIDADES —grupos hijos, cada uno con su
 * chat y sus miembros—. El contrato está en
 * `docs/CONTRATOS_TEMAS_Y_COMUNIDADES.md`.
 *
 * Aquí está lo que se puede probar sin montar nada: leer lo que manda el
 * servidor sin romperse, juntar páginas de un tema sin repetir mensajes, decir
 * qué botón le toca a cada comunidad y qué fila de la bandeja abre la lista.
 *
 * LOS PERMISOS NO ESTÁN AQUÍ. `puedoAdministrar` solo sirve para no pintar
 * botones que responderían 403; quién puede crear un tema o borrar un mensaje
 * ajeno lo decide el servidor en cada petición.
 *
 * NUNCA UN BOTÓN MUERTO. Sin las migraciones 0108 o 0109 el servidor responde
 * `available: false` y la lista vacía. Eso se lee aquí como «la función no
 * existe todavía», y la pantalla no ofrece ni la sección ni sus botones.
 *
 * Sin importaciones, a propósito: se prueba con `node --test` tal cual, como
 * `vistasDeChat.ts`.
 */

// ---------------------------------------------------------------------------
// Los topes del servidor, repetidos solo para no dejar escribir de más
// ---------------------------------------------------------------------------

/** El nombre de un tema: `char_length(nombre) between 1 and 40` en la 0108. */
export const MAX_NOMBRE_DE_TEMA = 40;
/** Temas por grupo (`topics_limit`). */
export const MAX_TEMAS_POR_GRUPO = 20;
/** El nombre de una comunidad: los mismos topes que el de un grupo. */
export const MAX_TITULO_DE_COMUNIDAD = 60;
/** La descripción de una comunidad (`char_length(descripcion) <= 200`). */
export const MAX_DESCRIPCION_DE_COMUNIDAD = 200;
/** Lo que trae cada página de un tema, y lo máximo que acepta el servidor. */
export const MENSAJES_DE_TEMA_POR_PAGINA = 30;
export const MAX_MENSAJES_DE_TEMA_POR_PAGINA = 60;

/**
 * Los iconos que puede llevar un tema. LISTA CERRADA, la misma del servidor:
 * uno desconocido se guarda allí como `folder`, y aquí se lee igual.
 *
 * Son todos nombres de Feather, así que la pantalla los pinta tal cual.
 */
export const ICONOS_DE_TEMA = [
  'folder',
  'bell',
  'video',
  'mic',
  'link',
  'image',
  'file-text',
  'star',
  'book',
  'calendar',
] as const;
export type IconoDeTema = (typeof ICONOS_DE_TEMA)[number];

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Qué era lo último de un tema o de una comunidad, para resumirlo sin texto. */
export type TipoDeUltimo = 'text' | 'link' | 'image' | 'video' | 'document' | 'audio';

/** Lo último que pasó en un tema o en una comunidad, para la vista previa. */
export type UltimoMensaje = {
  autor: string;
  /** Vacío si no tenía texto: entonces se dice qué era (`resumenDeUltimo`). */
  extracto: string;
  tipo: TipoDeUltimo;
  fechaIso: string | null;
  /** En un tema: lo escribió la administración allí, no viene de General. */
  propio: boolean;
};

export type TemaDeGrupo = {
  id: string;
  nombre: string;
  icono: IconoDeTema;
  posicion: number;
  /** El chat propio del tema: ahí escribe la administración y ahí se escucha. */
  chatId: string;
  /** Mensajes de General que el tema referencia (solo los vivos). */
  referencias: number;
  /** Mensajes escritos solo en el tema (solo los vivos). */
  propios: number;
  /** Lo que quien pregunta todavía no ha visto. */
  sinVer: number;
  /** Solo al preguntar por un mensaje: si ya está en este tema. */
  contiene: boolean | null;
  ultimo: UltimoMensaje | null;
};

export type TemasDeGrupo = {
  /** `false` sin la 0108: la sección no se pinta. */
  disponible: boolean;
  /** Comodidad para no pintar botones que responderían 403. */
  puedoAdministrar: boolean;
  temas: TemaDeGrupo[];
};

export const SIN_TEMAS: TemasDeGrupo = { disponible: false, puedoAdministrar: false, temas: [] };

/** `open`: se entra con un toque. `request`: se pide y decide la administración (D2). */
export type EntradaDeComunidad = 'open' | 'request';

export type ComunidadDeGrupo = {
  id: string;
  titulo: string;
  avatarPath?: string;
  descripcion: string;
  entrada: EntradaDeComunidad;
  posicion: number;
  miembros: number;
  soyMiembro: boolean;
  /** Quien pregunta pidió entrar y espera respuesta. */
  solicitudPendiente: boolean;
  /** Solicitudes que esperan. Solo para quien administra; a los demás, cero. */
  solicitudes: number;
  /** Solo si es miembro: quien no está dentro no ve mensajes. */
  sinLeer: number;
  ultimo: UltimoMensaje | null;
};

export type ComunidadesDeGrupo = {
  /** `false` sin la 0109: la sección no se pinta. */
  disponible: boolean;
  puedoAdministrar: boolean;
  comunidades: ComunidadDeGrupo[];
};

export const SIN_COMUNIDADES: ComunidadesDeGrupo = {
  disponible: false,
  puedoAdministrar: false,
  comunidades: [],
};

// ---------------------------------------------------------------------------
// Leer sin fiarse de nada
// ---------------------------------------------------------------------------

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const textoDe = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Un número que cuenta cosas: entero y nunca negativo.
 *
 * Una cuenta que llega como texto, negativa o con decimales no se cree a
 * medias: se lee como cero. Un globo con «-1» o «2.5» sin leer no dice nada.
 */
export function leerCuenta(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

const TIPOS_DE_ULTIMO: readonly string[] = ['text', 'link', 'image', 'video', 'document', 'audio'];

/** El icono de un tema; lo que no está en la lista cerrada es una carpeta. */
export function iconoDeTema(v: unknown): IconoDeTema {
  return typeof v === 'string' && (ICONOS_DE_TEMA as readonly string[]).includes(v)
    ? (v as IconoDeTema)
    : 'folder';
}

/** El `last` de un tema o de una comunidad. `null` si está vacío o no se entiende. */
export function leerUltimo(bruto: unknown): UltimoMensaje | null {
  if (!esObjeto(bruto)) return null;
  const tipo =
    typeof bruto.kind === 'string' && TIPOS_DE_ULTIMO.includes(bruto.kind)
      ? (bruto.kind as TipoDeUltimo)
      : 'text';
  return {
    autor: textoDe(bruto.sender_name),
    extracto: textoDe(bruto.excerpt),
    tipo,
    fechaIso: typeof bruto.at === 'string' && bruto.at ? bruto.at : null,
    propio: bruto.own === true,
  };
}

/** Un `TemaLeido`. `null` si le falta lo que hace falta para abrirlo. */
export function leerTema(bruto: unknown): TemaDeGrupo | null {
  if (!esObjeto(bruto)) return null;
  const id = typeof bruto.id === 'string' ? bruto.id : '';
  const chatId = typeof bruto.chat_id === 'string' ? bruto.chat_id : '';
  const nombre = textoDe(bruto.name);
  // Sin su chat no se puede escuchar ni escribir en él; sin nombre, la fila
  // estaría en blanco. Mejor no pintarlo que pintar algo que no se abre bien.
  if (!id || !chatId || !nombre) return null;
  return {
    id,
    nombre,
    icono: iconoDeTema(bruto.icon),
    posicion: typeof bruto.position === 'number' ? Math.floor(bruto.position) : 0,
    chatId,
    referencias: leerCuenta(bruto.references),
    propios: leerCuenta(bruto.own),
    sinVer: leerCuenta(bruto.unseen),
    contiene: typeof bruto.contains === 'boolean' ? bruto.contains : null,
    ultimo: leerUltimo(bruto.last),
  };
}

/** Quita los repetidos por identificador, quedándose con el primero. */
function sinRepetir<T extends { id: string }>(lista: T[]): T[] {
  const vistos = new Set<string>();
  return lista.filter((cosa) => {
    if (vistos.has(cosa.id)) return false;
    vistos.add(cosa.id);
    return true;
  });
}

/**
 * Lo que dice `GET /{grupo}/topics`.
 *
 * EL ORDEN ES EL DEL SERVIDOR (posición y después fecha de creación), que es
 * el mismo para todos. Reordenar aquí con otro criterio haría que dos
 * personas vieran la lista distinta.
 *
 * Sin `available: true` no hay temas, diga lo que diga el resto: la pantalla
 * no ofrece una sección que no puede llenarse.
 */
export function leerTemas(bruto: unknown): TemasDeGrupo {
  if (!esObjeto(bruto) || bruto.available !== true) return SIN_TEMAS;
  const temas = Array.isArray(bruto.topics)
    ? bruto.topics.map(leerTema).filter((t): t is TemaDeGrupo => t !== null)
    : [];
  return { disponible: true, puedoAdministrar: bruto.can_manage === true, temas: sinRepetir(temas) };
}

/** Una `ComunidadLeida`. `null` si no se entiende. */
export function leerComunidad(bruto: unknown, puedoAdministrar = false): ComunidadDeGrupo | null {
  if (!esObjeto(bruto)) return null;
  const id = typeof bruto.id === 'string' ? bruto.id : '';
  const titulo = textoDe(bruto.title);
  if (!id || !titulo) return null;
  const soyMiembro = bruto.is_member === true;
  return {
    id,
    titulo,
    avatarPath:
      typeof bruto.avatar_path === 'string' && bruto.avatar_path ? bruto.avatar_path : undefined,
    descripcion: textoDe(bruto.description),
    // Lo que no sea `request` es abierta: es el valor por omisión de la 0109.
    entrada: bruto.entry === 'request' ? 'request' : 'open',
    posicion: typeof bruto.position === 'number' ? Math.floor(bruto.position) : 0,
    miembros: leerCuenta(bruto.members_count),
    soyMiembro,
    // Quien ya está dentro no espera nada, aunque la respuesta dijera otra cosa.
    solicitudPendiente: !soyMiembro && bruto.request_pending === true,
    // Las solicitudes son cosa de quien administra: a los demás, cero siempre.
    solicitudes: puedoAdministrar ? leerCuenta(bruto.pending_requests) : 0,
    // Quien no está dentro no ve mensajes: ni cuántos ni cuál fue el último.
    sinLeer: soyMiembro ? leerCuenta(bruto.unread_count) : 0,
    ultimo: soyMiembro ? leerUltimo(bruto.last) : null,
  };
}

/** Lo que dice `GET /{grupo}/subgroups`. Mismas reglas que `leerTemas`. */
export function leerComunidades(bruto: unknown): ComunidadesDeGrupo {
  if (!esObjeto(bruto) || bruto.available !== true) return SIN_COMUNIDADES;
  const puedoAdministrar = bruto.can_manage === true;
  const comunidades = Array.isArray(bruto.subgroups)
    ? bruto.subgroups
        .map((fila) => leerComunidad(fila, puedoAdministrar))
        .filter((c): c is ComunidadDeGrupo => c !== null)
    : [];
  return { disponible: true, puedoAdministrar, comunidades: sinRepetir(comunidades) };
}

// ---------------------------------------------------------------------------
// Los mensajes de un tema
// ---------------------------------------------------------------------------

/**
 * Lo que un mensaje de un tema trae ADEMÁS de lo de un mensaje normal.
 *
 * `conversacionId` es el de VERDAD: General si es una referencia y el chat del
 * tema si se escribió allí. Es el que se usa para reaccionar y para borrar; con
 * el del tema, reaccionar a una referencia respondería 404.
 */
export type DatosDeTema = {
  propio: boolean;
  conversacionId: string;
  anadidoPor: { id: string; nombre: string } | null;
  anadidoEnIso: string | null;
  /** Lo que ordena el tema: cuándo se agregó (referencia) o se escribió (propio). */
  ordenIso: string;
};

/** Los campos de `TemaMensaje` que no son de `MessageRead`. `null` si no se entienden. */
export function leerDatosDeTema(bruto: unknown): DatosDeTema | null {
  if (!esObjeto(bruto) || typeof bruto.conversation_id !== 'string' || !bruto.conversation_id) {
    return null;
  }
  // Sin `order_at` se ordena por cuándo se escribió: es lo más parecido que hay.
  const ordenIso =
    typeof bruto.order_at === 'string' && bruto.order_at
      ? bruto.order_at
      : typeof bruto.created_at === 'string'
        ? bruto.created_at
        : '';
  if (!ordenIso) return null;
  const quien = esObjeto(bruto.added_by) ? bruto.added_by : null;
  const idDeQuien = quien && typeof quien.id === 'string' ? quien.id : '';
  const nombreDeQuien = quien
    ? textoDe(quien.full_name) || textoDe(quien.username)
    : '';
  return {
    propio: bruto.own === true,
    conversacionId: bruto.conversation_id,
    anadidoPor: idDeQuien ? { id: idDeQuien, nombre: nombreDeQuien } : null,
    anadidoEnIso: typeof bruto.added_at === 'string' && bruto.added_at ? bruto.added_at : null,
    ordenIso,
  };
}

/**
 * Una página de `GET …/topics/{tema}/messages`: las filas que se pueden pintar
 * y si queda algo más atrás.
 *
 * Devuelve las filas CRUDAS que tienen forma de mensaje; convertirlas en
 * `Message` es cosa del repositorio, que sabe de fechas y de firmas. Una fila
 * sin remitente o sin sus datos de tema se deja fuera: rompería la burbuja.
 */
export function leerPaginaDeTema(bruto: unknown): { filas: Record<string, unknown>[]; hayMas: boolean } {
  if (!esObjeto(bruto)) return { filas: [], hayMas: false };
  const filas = Array.isArray(bruto.items)
    ? bruto.items.filter(
        (fila): fila is Record<string, unknown> =>
          esObjeto(fila) &&
          typeof fila.id === 'string' &&
          !!fila.id &&
          esObjeto(fila.sender) &&
          typeof fila.sender.id === 'string' &&
          leerDatosDeTema(fila) !== null,
      )
    : [];
  return { filas, hayMas: bruto.has_more === true };
}

type Ordenable = { id: string; ordenIso: string };

/**
 * De lo más antiguo a lo más reciente, como un chat.
 *
 * El desempate por identificador evita que dos mensajes del mismo instante
 * bailen entre repintados.
 */
function comparar(a: Ordenable, b: Ordenable): number {
  if (a.ordenIso !== b.ordenIso) return a.ordenIso < b.ordenIso ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Junta lo que ya se tenía con lo que llega, SIN REPETIR y en orden.
 *
 * Gana la versión nueva de un mensaje que ya estaba: trae las reacciones y
 * los adjuntos firmados más recientes. Es lo que se usa al subir por el
 * historial (`before`).
 */
export function fusionarMensajesDeTema<T extends Ordenable>(
  actuales: readonly T[],
  nuevos: readonly T[],
): T[] {
  const porId = new Map<string, T>();
  for (const m of actuales) porId.set(m.id, m);
  for (const m of nuevos) porId.set(m.id, m);
  return [...porId.values()].sort(comparar);
}

/**
 * Pone al día lo más reciente de un tema con la última página que se pidió.
 *
 * NO BASTA CON FUSIONAR. En un tema las cosas también DESAPARECEN: la
 * administración quita una referencia, alguien borra en General el mensaje
 * referenciado, se borra lo escrito en el tema. Fusionar dejaría esas burbujas
 * para siempre. Así que en el tramo que cubre la página nueva manda ella sola,
 * y de lo anterior se conserva lo que ya se había bajado subiendo por el
 * historial.
 *
 * Si la página dice que no hay nada más atrás, ES el tema entero.
 */
export function refrescarLoReciente<T extends Ordenable>(
  actuales: readonly T[],
  pagina: readonly T[],
  hayMas: boolean,
): T[] {
  const nuevos = [...pagina].sort(comparar);
  if (!hayMas || nuevos.length === 0) return hayMas ? [...actuales] : nuevos;
  const corte = nuevos[0]!;
  const anteriores = actuales.filter((m) => comparar(m, corte) < 0);
  const vistos = new Set(nuevos.map((m) => m.id));
  return [...anteriores.filter((m) => !vistos.has(m.id)), ...nuevos];
}

/** El instante desde el que pedir la página anterior (`before`). */
export function instanteMasAntiguoDeTema(lista: readonly Ordenable[]): string | null {
  let menor: string | null = null;
  for (const m of lista) {
    if (m.ordenIso && (menor === null || m.ordenIso < menor)) menor = m.ordenIso;
  }
  return menor;
}

// ---------------------------------------------------------------------------
// El aviso de temas
// ---------------------------------------------------------------------------

/**
 * Lo único que puede decir un aviso de `chat-temas:{grupo}`: «se ha escrito un
 * mensaje en tal tema» (28/10/2026).
 *
 * POR QUÉ. El aviso no llevaba nada, así que cada mensaje escrito en un tema
 * hacía que TODO tema abierto del grupo volviera a pedir la lista de temas, su
 * página y su «visto», aunque el mensaje fuera de otro. Con la pista, el tema
 * de ese mensaje pide solo su página y los demás no piden nada.
 *
 * ES UNA PISTA, NO UNA VERDAD: el canal lo puede escribir cualquiera. Lo peor
 * que consigue una falsa es que un tema no recargue por ELLA; los cambios de
 * verdad mandan su propio aviso. Y un aviso sin pista —el de una versión
 * anterior, o el de un cambio que no es un mensaje— es `null`: «algo cambió,
 * vuelve a preguntarlo todo», como siempre.
 */
export type PistaDeTemas = { tipo: 'mensaje'; tema: string };

/** La pista de un aviso, o `null` si no trae una que se entienda. */
export function leerPistaDeTemas(bruto: unknown): PistaDeTemas | null {
  if (!bruto || typeof bruto !== 'object') return null;
  const { tipo, tema } = bruto as Record<string, unknown>;
  if (tipo !== 'mensaje' || typeof tema !== 'string' || !tema) return null;
  return { tipo, tema };
}

/**
 * Dos avisos que esperan a que el canal se una se mandan como uno. Si dicen lo
 * mismo, con su pista; si no, sin ella: «algo cambió» cubre los dos.
 */
export function juntarPistas(
  previa: PistaDeTemas | null | undefined,
  nueva: PistaDeTemas | null,
): PistaDeTemas | null {
  if (previa === undefined) return nueva;
  if (previa && nueva && previa.tema === nueva.tema) return nueva;
  return null;
}

// ---------------------------------------------------------------------------
// La bandeja
// ---------------------------------------------------------------------------

/** Lo mínimo de una fila de la bandeja para decidir lo de los temas. */
export type FilaConTemas = {
  unread: number;
  esGrupo?: boolean;
  temas?: number;
  comunidades?: number;
  totalSinLeer?: number;
};

/**
 * Si tocar la fila abre la LISTA del grupo (General, temas y comunidades) en
 * vez del chat directamente.
 *
 * Solo cuando hay algo más que General: un grupo sin temas ni comunidades se
 * abre como siempre, y quien no los usa no nota ninguna pantalla de más.
 */
export function abreLaLista(fila: FilaConTemas): boolean {
  return fila.esGrupo !== false && (fila.temas ?? 0) + (fila.comunidades ?? 0) > 0;
}

/**
 * Lo que dice el globo de una fila de la bandeja.
 *
 * En un grupo con temas y comunidades es `total_unread`: General, las
 * comunidades donde se está y lo escrito en los temas. Las comunidades ya no
 * salen sueltas en la bandeja (D12), así que si no sumaran aquí no sumarían en
 * ningún sitio.
 *
 * SE TOMA EL MAYOR, y no `total_unread` a secas: el total incluye siempre lo de
 * General, así que nunca puede ser menor. Si llega más pequeño —un servidor que
 * aún no lo calcula y manda el cero por omisión— lo que se cree es la cuenta de
 * General, que es la de siempre.
 */
export function sinLeerDeLaFila(fila: FilaConTemas): number {
  return Math.max(leerCuenta(fila.unread), leerCuenta(fila.totalSinLeer));
}

// ---------------------------------------------------------------------------
// Las comunidades
// ---------------------------------------------------------------------------

/**
 * Qué se ofrece en la fila de una comunidad.
 *
 * `abrir`: ya se está dentro y la fila abre su chat. `unirme`: es abierta, un
 * toque. `pedir`: hay que pedirlo. `retirar`: ya se pidió y se puede retirar.
 */
export type AccionDeComunidad = 'abrir' | 'unirme' | 'pedir' | 'retirar';

export function accionDeComunidad(
  comunidad: Pick<ComunidadDeGrupo, 'soyMiembro' | 'entrada' | 'solicitudPendiente'>,
): AccionDeComunidad {
  if (comunidad.soyMiembro) return 'abrir';
  if (comunidad.solicitudPendiente) return 'retirar';
  return comunidad.entrada === 'open' ? 'unirme' : 'pedir';
}

// ---------------------------------------------------------------------------
// Escribir nombres
// ---------------------------------------------------------------------------

/** El nombre tal como se guardará: sin espacios de más. */
export function limpiarNombre(texto: string): string {
  return texto.split(/\s+/).filter(Boolean).join(' ');
}

/** Minúsculas y sin tildes: «Anuncios» y «anúncios» chocan en el servidor. */
function plegar(texto: string): string {
  return limpiarNombre(texto)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export type JuicioDeNombre = 'vale' | 'vacio' | 'largo' | 'repetido';

/**
 * Si se puede mandar ya el nombre de un tema.
 *
 * Lo repetido lo decide de verdad el servidor (`topic_name_taken`); esto solo
 * evita el viaje cuando ya se ve en la lista que existe.
 */
export function juzgarNombreDeTema(
  texto: string,
  existentes: readonly string[] = [],
): JuicioDeNombre {
  const limpio = limpiarNombre(texto);
  if (!limpio) return 'vacio';
  if (limpio.length > MAX_NOMBRE_DE_TEMA) return 'largo';
  const plegado = plegar(limpio);
  return existentes.some((nombre) => plegar(nombre) === plegado) ? 'repetido' : 'vale';
}

/** Si se puede mandar ya el nombre de una comunidad. */
export function juzgarTituloDeComunidad(
  texto: string,
  existentes: readonly string[] = [],
): JuicioDeNombre {
  const limpio = limpiarNombre(texto);
  if (!limpio) return 'vacio';
  if (limpio.length > MAX_TITULO_DE_COMUNIDAD) return 'largo';
  const plegado = plegar(limpio);
  return existentes.some((nombre) => plegar(nombre) === plegado) ? 'repetido' : 'vale';
}

// ---------------------------------------------------------------------------
// Lo que se lee en la lista
// ---------------------------------------------------------------------------

/**
 * Lo que se pinta de lo último de un tema o comunidad: su texto, o qué era si
 * no tenía.
 *
 * Devuelve el texto tal cual o la CLAVE de traducción que toca, como
 * `textoDeCita`: así esta función no depende del idioma. Las claves son las
 * mismas que ya usan las citas del chat.
 */
export function resumenDeUltimo(ultimo: UltimoMensaje): { texto: string } | { clave: string } {
  if (ultimo.extracto) return { texto: ultimo.extracto };
  switch (ultimo.tipo) {
    case 'image':
      return { clave: 'chat.replyPhoto' };
    case 'video':
      return { clave: 'chat.replyVideo' };
    case 'audio':
      return { clave: 'chat.replyAudio' };
    case 'document':
      return { clave: 'chat.replyFile' };
    default:
      return { clave: 'chat.replyMessage' };
  }
}

/**
 * La clave del texto que explica un rechazo del servidor en temas o
 * comunidades. `null` si el código no es de aquí: entonces quien llama prueba
 * con `claveDelFalloDeGrupo`, que conoce los de los grupos y tiene el genérico.
 */
export function claveDelFalloDeTemas(codigo: string | null | undefined): string | null {
  switch (codigo) {
    case 'topic_name_taken':
      return 'groupTopics.errorNameTaken';
    case 'topics_limit':
      return 'groupTopics.errorLimit';
    case 'topics_unavailable':
      return 'groupTopics.errorUnavailable';
    case 'topic_admin_only':
      return 'groupTopics.errorAdminOnly';
    case 'topic_not_found':
      return 'groupTopics.errorGone';
    case 'message_not_in_group':
      return 'groupTopics.errorMessageGone';
    case 'not_a_top_level_group':
      return 'groupTopics.errorNotTopLevel';
    case 'subgroups_unavailable':
      return 'groupCommunities.errorUnavailable';
    case 'subgroup_requires_request':
      return 'groupCommunities.errorNeedsRequest';
    case 'subgroup_not_found':
      return 'groupCommunities.errorGone';
    default:
      return null;
  }
}
