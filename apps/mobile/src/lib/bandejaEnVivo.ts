/**
 * La bandeja puesta al día con el mensaje que trae el tiempo real, SIN
 * preguntar al servidor.
 *
 * EL PROBLEMA (auditoría del 28/10, §10, medido). Cada mensaje nuevo hacía que
 * cada teléfono conectado volviera a pedir la bandeja entera
 * (`GET /conversations`, la consulta más cara de la API) y el contador de
 * avisos. Con N miembros de un grupo conectados, un mensaje eran 2N
 * peticiones; con doscientos, la API tardaba unos diez segundos en atender ese
 * mensaje en producción. Y todo para enterarse de algo que el propio mensaje
 * ya dice: de qué conversación es, quién lo escribió, qué pone y cuándo.
 *
 * AHORA el mensaje se aplica aquí: la fila sube arriba, enseña el texto y la
 * hora, y suma uno a lo no leído si no es propio y no se está mirando esa
 * conversación. El servidor solo se consulta cuando el teléfono NO PUEDE saber
 * la respuesta (ver `EfectoDelMensaje`) y, como red de seguridad, como mucho
 * una vez cada `RECARGA_DE_SEGURIDAD_MS` mientras sigan llegando mensajes.
 *
 * LA REGLA QUE HACE QUE EL GLOBO NO MIENTA. Un mensaje solo se suma si es
 * POSTERIOR al último que la fila ya conoce (`ultimoMensajeEn`, que viene del
 * servidor). Así da igual por dónde llegue dos veces —el tiempo real y una
 * lectura que salió antes, o una lectura que lo trajo y el tiempo real que
 * llega después—: el segundo encuentra la fila al día y no suma. Es la misma
 * regla con la que el servidor cuenta los no leídos (`lectura.py`, `no_leidos`):
 * lo escrito por OTRA persona, vivo, después de la última lectura.
 *
 * Sin importaciones, a propósito: se prueba con `node --test` tal cual.
 */

/** Lo que hace falta de una fila de la bandeja. `Conversation` lo cumple. */
export type FilaEnVivo = {
  id: string;
  subtitle: string;
  unread: number;
  time?: string;
  /** Instante del último mensaje que la fila ya cuenta (ISO del servidor). */
  ultimoMensajeEn?: string | null;
  /** General + temas + comunidades. Ver `sinLeerDeLaFila`. */
  totalSinLeer?: number;
};

/** Un mensaje que acaba de entrar, leído sin fiarse de nada. */
export type MensajeEnVivo = {
  id: string | null;
  conversacionId: string;
  remitenteId: string | null;
  /** El texto tal cual. Vacío en una foto o una nota de voz sin texto. */
  texto: string;
  /** `created_at` de la fila, tal y como lo manda la base. */
  creadoEn: string | null;
};

/**
 * Qué pasó al aplicar un mensaje, y por tanto qué le falta a la bandeja.
 *
 * - `aplicado`: la fila ya dice lo que diría el servidor. No hace falta nada.
 * - `sin-resumen`: aplicado, pero el mensaje no trae texto (una foto, un
 *   vídeo, una nota de voz) y el resumen —«Foto», «Video»…— solo lo sabe el
 *   servidor, que mira los adjuntos. El orden y el globo SÍ están bien.
 * - `ya-estaba`: la fila ya contaba ese mensaje (o uno posterior).
 * - `desconocida`: la conversación no está en la portada —es nueva, viene de
 *   más abajo, o es el chat de un tema o una comunidad, que en la bandeja
 *   agrupada viven dentro de su grupo—. Solo el servidor sabe dónde va.
 * - `incierto`: no se puede comparar el instante del mensaje con el de la
 *   fila. Antes que arriesgar un globo de más, se pregunta.
 */
export type EfectoDelMensaje = 'aplicado' | 'sin-resumen' | 'ya-estaba' | 'desconocida' | 'incierto';

/**
 * El mensaje que manda el tiempo real (`postgres_changes`, INSERT en
 * `messages`), comprobado campo a campo.
 *
 * `null` si no es un mensaje que se pueda colocar: sin conversación no hay
 * fila a la que llevarlo.
 */
export function leerMensajeEnVivo(bruto: unknown): MensajeEnVivo | null {
  if (typeof bruto !== 'object' || bruto === null) return null;
  const fila = bruto as Record<string, unknown>;
  const conversacionId = typeof fila.conversation_id === 'string' ? fila.conversation_id : '';
  if (!conversacionId) return null;
  return {
    id: typeof fila.id === 'string' && fila.id ? fila.id : null,
    conversacionId,
    remitenteId: typeof fila.sender_id === 'string' && fila.sender_id ? fila.sender_id : null,
    texto: typeof fila.body === 'string' ? fila.body : '',
    creadoEn: typeof fila.created_at === 'string' && fila.created_at ? fila.created_at : null,
  };
}

const INSTANTE =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?(?:[.,](\d+))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * Un instante ISO en MICROSEGUNDOS desde 1970, o `null` si no se entiende.
 *
 * MICROSEGUNDOS Y NO `Date.parse` A SECAS. La base guarda microsegundos y dos
 * mensajes seguidos pueden caer en el mismo milisegundo: comparando
 * milisegundos, el segundo parecería «ya contado» y el globo se quedaría corto.
 * Cabe sin pérdida en un `number` (unos 1,8·10¹⁵, lejos de 2⁵³).
 *
 * Acepta las dos formas que llegan: la del servidor («…T12:00:00.123456Z» o
 * «+00:00») y la de Postgres por el tiempo real («… 12:00:00.123456+00»).
 */
export function instanteExacto(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string') return null;
  const partes = INSTANTE.exec(iso.trim());
  if (!partes) return null;
  const [, fecha, horaYMinuto, segundos = '00', fraccion = '', zonaCruda] = partes;
  let zona = (zonaCruda ?? 'Z').toUpperCase();
  if (zona !== 'Z') {
    const digitos = zona.slice(1).replace(':', '');
    zona = `${zona[0]}${digitos.slice(0, 2)}:${(digitos.slice(2) || '00').padEnd(2, '0')}`;
  }
  const milisegundos = Date.parse(`${fecha}T${horaYMinuto}:${segundos}${zona}`);
  if (Number.isNaN(milisegundos)) return null;
  const micro = Number((fraccion + '000000').slice(0, 6));
  return milisegundos * 1000 + micro;
}

/**
 * Aplica un mensaje a la portada de la bandeja.
 *
 * Devuelve LA MISMA lista si no cambia nada (para no repintar), y una nueva
 * con la fila arriba si se aplicó: el servidor ordena por la última actividad
 * y un mensaje es la actividad más reciente.
 *
 * - `propio`: lo escribió quien mira (desde este aparato o desde otro). Mueve
 *   la fila y cambia el resumen, pero no es «sin leer» para quien lo escribió.
 * - `abierta`: esa conversación está en pantalla. El chat la marca leída en
 *   cuanto llega, así que tampoco suma.
 * - `hora`: cómo se escribe la hora en la fila (la misma función que usa el
 *   mapeador, para que la fila no cambie de formato al recargar).
 */
export function aplicarMensaje<T extends FilaEnVivo>(
  lista: readonly T[],
  mensaje: MensajeEnVivo,
  contexto: { propio: boolean; abierta: boolean; hora: (iso: string | null) => string },
): { lista: readonly T[]; efecto: EfectoDelMensaje } {
  const posicion = lista.findIndex((fila) => fila.id === mensaje.conversacionId);
  if (posicion === -1) return { lista, efecto: 'desconocida' };
  const fila = lista[posicion] as T;

  const nuevo = instanteExacto(mensaje.creadoEn);
  if (nuevo === null) return { lista, efecto: 'incierto' };
  // Sin último mensaje (grupo recién creado, chat vaciado) no hay con qué
  // compararlo: todo lo que llegue es posterior.
  if (fila.ultimoMensajeEn) {
    const ultimo = instanteExacto(fila.ultimoMensajeEn);
    if (ultimo === null) return { lista, efecto: 'incierto' };
    if (nuevo <= ultimo) return { lista, efecto: 'ya-estaba' };
  }

  const suma = !contexto.propio && !contexto.abierta;
  // Lo mismo que hace el servidor: el resumen es el texto TAL CUAL, y solo
  // si no hay texto se busca otra cosa (que aquí no se sabe).
  const conTexto = mensaje.texto.trim().length > 0;
  const actualizada: T = {
    ...fila,
    subtitle: conTexto ? mensaje.texto : fila.subtitle,
    time: contexto.hora(mensaje.creadoEn),
    ultimoMensajeEn: mensaje.creadoEn,
    unread: suma ? (fila.unread || 0) + 1 : fila.unread,
    ...(suma && typeof fila.totalSinLeer === 'number'
      ? { totalSinLeer: fila.totalSinLeer + 1 }
      : {}),
  };
  return {
    lista: [actualizada, ...lista.slice(0, posicion), ...lista.slice(posicion + 1)],
    efecto: conTexto ? 'aplicado' : 'sin-resumen',
  };
}

/* ------------------------------------------------------------------------- */
/* CUÁNDO SE PREGUNTA AL SERVIDOR                                            */
/* ------------------------------------------------------------------------- */

/**
 * La recarga de seguridad: como mucho UNA cada este tiempo, mientras sigan
 * llegando mensajes. Sale entre `RECARGA_DE_SEGURIDAD_MS` y
 * `RECARGA_DE_SEGURIDAD_MS + DISPERSION_DE_LA_RECARGA_MS` después del primer
 * mensaje de la tanda.
 *
 * PARA QUÉ, si el mensaje ya se aplicó bien. Para lo poco que el teléfono no
 * puede saber: dos mensajes que la base confirma en otro orden que su hora
 * (el segundo llega «ya contado» y el globo se queda corto), el resumen de un
 * adjunto, o una conversación leída en otro aparato. Sin esto, cualquiera de
 * las tres dejaría un globo mal hasta salir y volver a Mensajes.
 *
 * VEINTE SEGUNDOS. Con la dispersión, la recarga sale como muy tarde a los
 * treinta, que es la validez de la bandeja al enfocar
 * (`VALIDEZ_DE_LA_BANDEJA_MS`) y la vuelta de los avisos: lo que se ve nunca
 * pasa más de medio minuto sin contrastarse con el servidor mientras haya
 * movimiento. Y el coste: cada teléfono hace como mucho una lectura por
 * ventana, así que un grupo animado con doscientas personas conectadas son,
 * de media, 200 / 20 = 10 lecturas por segundo mientras dure la conversación
 * (con quince serían más de trece). Antes eran 400 peticiones de golpe por
 * CADA mensaje.
 */
export const RECARGA_DE_SEGURIDAD_MS = 20_000;

/**
 * Cuánto se reparte al azar la recarga de seguridad.
 *
 * Todos los teléfonos de un grupo reciben el mismo mensaje en el mismo
 * instante: sin repartir, los doscientos preguntarían a la vez dentro de
 * veinte segundos, que es justo el pico que se quería quitar. Con diez
 * segundos de reparto, esas doscientas lecturas llegan a unas veinte por
 * segundo en vez de todas en el mismo instante.
 */
export const DISPERSION_DE_LA_RECARGA_MS = 10_000;

/** Cuánto esperar a la recarga de seguridad. `azar` en [0, 1). */
export function esperaDeLaRecargaDeSeguridad(azar: number): number {
  const parte = Number.isFinite(azar) ? Math.min(Math.max(azar, 0), 1) : 0;
  return RECARGA_DE_SEGURIDAD_MS + Math.floor(parte * DISPERSION_DE_LA_RECARGA_MS);
}

/**
 * Si la recarga de seguridad todavía hace falta cuando le toca salir.
 *
 * NO, si después del último mensaje ya se pidió la bandeja al servidor por
 * otro motivo (se enfocó Mensajes, se reenganchó el canal, se salió de un
 * chat): esa lectura salió después de que el mensaje estuviera guardado, así
 * que ya lo trae. Se compara con cuándo se PIDIÓ, no con cuándo llegó.
 */
export function hayQueAsegurar(
  ultimoMensajeLlegadoEn: number | null,
  portadaPedidaEn: number | null,
): boolean {
  if (ultimoMensajeLlegadoEn === null) return false;
  return portadaPedidaEn === null || portadaPedidaEn < ultimoMensajeLlegadoEn;
}

/**
 * Qué hay que hacer con la bandeja después de aplicar un mensaje.
 *
 * - `nada`: no debería pasar nada más que la red de seguridad.
 * - `preguntar-ya`: la conversación es desconocida y no se sabe por qué, o no
 *   se pudo comparar. Se pregunta en el respiro (medio segundo), agrupando lo
 *   que llegue junto.
 *
 * UNA CONVERSACIÓN QUE YA SE BUSCÓ Y NO ESTABA en la portada (el chat de un
 * tema, una comunidad: en la bandeja agrupada viven dentro de su grupo) no se
 * vuelve a preguntar mensaje a mensaje: sería otra vez una petición por
 * mensaje en cada teléfono. Su globo —el total del grupo— se pone al día con
 * la recarga de seguridad.
 */
export function queHacerTrasElMensaje(
  efecto: EfectoDelMensaje,
  yaSeBuscoYNoEstaba: boolean,
): 'nada' | 'preguntar-ya' {
  if (efecto === 'incierto') return 'preguntar-ya';
  if (efecto === 'desconocida') return yaSeBuscoYNoEstaba ? 'nada' : 'preguntar-ya';
  return 'nada';
}

/**
 * Si un mensaje puede traer un aviso de la bandeja de notificaciones.
 *
 * LA API NO ESCRIBE UN AVISO POR MENSAJE (`messaging/avisos.py`: un mensaje
 * tiene su sitio en Mensajes, no en la campana). La única excepción son las
 * SESIONES: pedir, aceptar o cancelar una deja un aviso Y un mensaje en el
 * chat de las dos personas (`messaging/sesiones.py`), y ese chat es siempre
 * de DOS. Así que solo un mensaje de un chat de dos —o de uno que todavía no
 * se conoce, que puede ser la primera solicitud de alguien nuevo— justifica
 * preguntar por los avisos. Un mensaje de grupo, nunca: era la mitad de las
 * 2N peticiones.
 */
export function puedeTraerUnAviso(
  conversacion: { esGrupo?: boolean } | undefined,
  yaSeBuscoYNoEstaba: boolean,
): boolean {
  if (conversacion) return conversacion.esGrupo !== true;
  // Lo que ya se buscó y no salió en la bandeja no es un chat de dos: esos
  // salen siempre arriba en cuanto tienen un mensaje.
  return !yaSeBuscoYNoEstaba;
}

/**
 * Un conjunto que olvida lo más antiguo pasado un tope.
 *
 * Para las conversaciones que se buscaron y no estaban, y para los mensajes ya
 * aplicados: una sesión larga no puede ir acumulando identificadores.
 */
export function anotarConTope(conjunto: Set<string>, valor: string, tope: number): void {
  conjunto.delete(valor);
  conjunto.add(valor);
  while (conjunto.size > tope) {
    const primero = conjunto.values().next().value;
    if (primero === undefined) break;
    conjunto.delete(primero);
  }
}
