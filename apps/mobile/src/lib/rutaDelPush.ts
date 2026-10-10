/**
 * A dónde lleva tocar un aviso: el MAPA CERRADO de destinos.
 *
 * LO QUE HABÍA. Solo el aviso de un directo llevaba a algún sitio; tocar
 * cualquier otro —«te escribió», «comentó tu publicación», «aceptó tu
 * sesión»— abría la aplicación donde estuviera y nada más. Había que adivinar
 * a qué se refería y buscarlo a mano.
 *
 * POR QUÉ UN MAPA Y NO UNA RUTA EN EL AVISO. Lo que llega en un push viene de
 * fuera del teléfono. Si el aviso trajera «ve a esta ruta» y la aplicación
 * obedeciera, cualquiera capaz de fabricar un push decidiría qué pantalla se
 * abre. Aquí el aviso trae un TIPO y un IDENTIFICADOR, y es este fichero quien
 * decide el destino entre los que conoce. Un identificador que no sea un UUID
 * no llega a una ruta, y un tipo desconocido cae en la bandeja de avisos, que
 * siempre existe y no enseña nada que la persona no pueda ver ya.
 *
 * LLEGAR NO ES TENER PERMISO. Esto solo elige pantalla. Cada pantalla sigue
 * pidiendo sus datos al servidor con la sesión de quien la abre: si la
 * publicación se borró, o la conversación ya no es suya, es esa pantalla la
 * que lo dice, igual que si hubiera llegado por cualquier otro camino.
 *
 * SIN REACT NI EXPO: se prueba con el runner de Node.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** La bandeja: el destino de lo que no tiene uno mejor. */
export const RUTA_DE_LA_BANDEJA = '/notifications';

/** Los avisos que hablan de una publicación. Llevan `postId`. */
const DE_PUBLICACION: ReadonlySet<string> = new Set([
  'like',
  'comment',
  'comment_reply',
  'comment_like',
  'post_mention',
]);

/** Los avisos de la agenda: una sesión pedida, aceptada, movida… */
const DE_AGENDA: ReadonlySet<string> = new Set([
  'booking',
  'session_booked',
  'session_accepted',
  'session_rejected',
  'session_cancelled',
  'session_rescheduled',
  'session_completed',
]);

type Opciones = {
  /**
   * El mapa de los avisos al creador (su evento, curso, postulación o
   * producto), que vive en `lib/avisosAlCreador`. Se pasa desde fuera porque
   * este módulo se prueba con el runner de Node, que no resuelve importaciones
   * entre ficheros de la aplicación.
   */
  rutaDeDecision?: (tipo: string, entidadId: string | null | undefined) => string | null;
};

function uuid(valor: unknown): string | null {
  return typeof valor === 'string' && UUID.test(valor) ? valor : null;
}

/**
 * El destino de un aviso, o `null` si lo que llegó ni siquiera es un aviso.
 *
 * `null` significa «abre la aplicación sin más». Un aviso con forma de aviso
 * pero sin destino conocido lleva a la bandeja.
 */
export function rutaDelPush(datos: unknown, opciones: Opciones = {}): string | null {
  if (datos === null || typeof datos !== 'object' || Array.isArray(datos)) return null;
  const d = datos as Record<string, unknown>;
  const tipo = typeof d.type === 'string' ? d.type : '';

  // «Juan está en vivo» y «Juan te invita a su directo» abren lo mismo: la
  // sala. La invitación se contesta dentro, no desde la pantalla de bloqueo.
  if (tipo === 'live_started' || tipo === 'live_invited') {
    const directo = uuid(d.liveId);
    return directo ? `/live/${directo}` : RUTA_DE_LA_BANDEJA;
  }
  // «X quiere unirse a tu grupo»: a la ficha del grupo, donde se responde.
  // No al chat: ahí no hay nada que decidir.
  if (tipo === 'group_join') {
    const grupo = uuid(d.conversationId);
    return grupo ? `/chat/grupo/${grupo}` : '/messages';
  }
  if (tipo === 'message') {
    const conversacion = uuid(d.conversationId);
    // Sin conversación válida, a la lista de mensajes: ahí está sea cual sea.
    return conversacion ? `/chat/${conversacion}` : '/messages';
  }
  if (DE_PUBLICACION.has(tipo)) {
    const publicacion = uuid(d.postId);
    return publicacion ? `/post/${publicacion}` : RUTA_DE_LA_BANDEJA;
  }
  if (tipo === 'follow') {
    const perfil = uuid(d.profileId);
    return perfil ? `/profile/${perfil}` : RUTA_DE_LA_BANDEJA;
  }
  if (DE_AGENDA.has(tipo)) return '/agenda';

  // Una decisión sobre algo del creador: el mapa es el de la bandeja.
  const entidad = uuid(d.entityId);
  const deDecision = tipo ? opciones.rutaDeDecision?.(tipo, entidad) : null;
  if (deDecision) return deDecision;

  return RUTA_DE_LA_BANDEJA;
}

/**
 * A dónde lleva TOCAR un aviso del sistema, o `null` si la aplicación se queda
 * donde arranca, que es Inicio.
 *
 * DOS COSAS QUE NO SON UN DESTINO, y las dos salieron de un fallo real
 * (05/10/2026: «cada que entro a la aplicación me redirige a notificaciones»):
 *
 *  - LO QUE NO ES UN TOQUE. En Android la biblioteca de avisos toma por «han
 *    tocado un aviso» CUALQUIER dato con que el sistema abra la aplicación:
 *    `ExpoNotificationLifecycleListener.onCreate` no mira de quién son. Hay
 *    lanzadores —el de Xiaomi— que abren las aplicaciones con datos suyos, y
 *    esa «respuesta» llegaba en cada arranque, sin identificador y con datos
 *    que no son de ningún aviso: tipo desconocido, a la bandeja. Un aviso de
 *    verdad trae SIEMPRE su identificador (el del mensaje de Firebase, o el
 *    que le pone la biblioteca al pintarlo); lo que no lo trae no es un aviso.
 *  - LA BANDEJA. Un aviso sin destino propio ya no la abre. La aplicación
 *    empieza en Inicio y lo que haya sin leer lo dice un aviso flotante
 *    (`useAvisosEnVivo`), que es desde donde se entra a la bandeja.
 */
export function destinoDelToque(
  toque: { identificador: unknown; datos: unknown },
  opciones: Opciones = {},
): string | null {
  if (typeof toque.identificador !== 'string' || toque.identificador.trim() === '') return null;
  const ruta = rutaDelPush(toque.datos, opciones);
  return ruta === RUTA_DE_LA_BANDEJA ? null : ruta;
}

export function directoDelPush(datos: unknown): string | null {
  const ruta = rutaDelPush(datos);
  return ruta?.startsWith('/live/') ? ruta.slice('/live/'.length) : null;
}

/** La conversación de la que habla un aviso de mensaje, si es uno. */
export function conversacionDelPush(datos: unknown): string | null {
  if (datos === null || typeof datos !== 'object') return null;
  const d = datos as Record<string, unknown>;
  return d.type === 'message' ? uuid(d.conversationId) : null;
}

/**
 * El mensaje concreto del que habla un aviso de mensaje, si lo trae.
 *
 * Sirve para no avisar dos veces del mismo: con la aplicación abierta llega en
 * tiempo real y por push, y este identificador dice que son el mismo.
 */
export function mensajeDelPush(datos: unknown): string | null {
  if (datos === null || typeof datos !== 'object') return null;
  const d = datos as Record<string, unknown>;
  return d.type === 'message' ? uuid(d.messageId) : null;
}

/**
 * Si un push es de la agenda: pedir una sesión, aceptarla, cancelarla…
 *
 * Con la aplicación abierta ese aviso no lo pinta el oyente del push: se
 * entrega a la lectura de la bandeja, que es por donde llega también en vivo.
 * Así los dos caminos —el push y el mensaje que deja la sesión en el chat— dan
 * UN aviso, el que salga primero.
 */
export function esPushDeSesion(datos: unknown): boolean {
  if (datos === null || typeof datos !== 'object') return false;
  return (datos as Record<string, unknown>).type === 'booking';
}

/** La clave con la que se agrupan los avisos de una conversación. */
export function claveDeConversacion(conversacionId: string): string {
  return `conversacion:${conversacionId}`;
}

/**
 * Lo que hace que dos avisos sean «el mismo» en pantalla.
 *
 * Cinco mensajes seguidos de la misma conversación son un aviso que se
 * renueva, no cinco apilados. Lo demás se agrupa por tipo y por aquello de lo
 * que habla: dos «me gusta» a la misma publicación, uno.
 */
export function claveDelPush(datos: unknown): string {
  const conversacion = conversacionDelPush(datos);
  if (conversacion) return claveDeConversacion(conversacion);
  if (datos === null || typeof datos !== 'object') return 'aviso';
  const d = datos as Record<string, unknown>;
  const tipo = typeof d.type === 'string' ? d.type : 'aviso';
  const sobre =
    uuid(d.postId) ?? uuid(d.liveId) ?? uuid(d.profileId) ?? uuid(d.entityId) ?? uuid(d.id) ?? '';
  return `${tipo}:${sobre}`;
}
