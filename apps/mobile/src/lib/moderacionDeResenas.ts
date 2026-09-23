/**
 * Moderar una reseña de evento: las reglas, sin React y sin red.
 *
 * OCULTAR NO ES BORRAR, y es lo primero porque es lo que se confunde. Esconder
 * una reseña la saca de la lista pública y la deja entera en la base: su texto,
 * su puntuación y su autor siguen ahí, y `restaurar` la devuelve tal cual. En
 * este fichero NO HAY —ni puede haber— ninguna función que borre, elimine,
 * purgue o destruya nada: el servidor no publica esa ruta y ofrecerla en la
 * pantalla prometería algo irreversible que nadie ha decidido.
 *
 * NI EL AUTOR NI LA PUNTUACIÓN SE TOCAN. `moderar` en el servidor cambia el
 * estado, el motivo y quién lo hizo; nada más. Aquí solo hay funciones que
 * FORMATEAN esos dos campos para leerlos, ninguna que los transforme en algo
 * que se pueda mandar de vuelta.
 *
 * EL MOTIVO ES OBLIGATORIO PARA OCULTAR, y se comprueba ANTES de llamar. El
 * servidor acepta `reason: null` al esconder, así que si el cliente no lo exige
 * nadie lo exige: quedaría una reseña escondida sin nadie que pueda decir por
 * qué, ni a quien la escribió ni a quien la revise después. Restaurar es el
 * movimiento contrario —devuelve algo, no lo quita— y por eso su motivo es
 * opcional; se manda si se escribe.
 *
 * SE LISTAN LAS VISIBLES Y LAS ESCONDIDAS. Sin poder ver lo escondido,
 * restaurar es imposible y nadie puede comprobar qué se escondió ni por qué.
 *
 * UN ESTADO DESCONOCIDO NO REVIENTA NADA. La base admite también `draft`, y
 * mañana puede admitir otro. Todo lo que traduce cae en una clave
 * `…desconocido` y `accionQueOfrece` devuelve `null`: se enseña la reseña sin
 * botón en vez de ofrecer una acción inventada sobre un estado que no se
 * entiende.
 *
 * Sin importaciones entre ficheros en tiempo de ejecución: el ejecutor de
 * pruebas de Node no resuelve el alias `@/`.
 */

/** Una clave del diccionario. La convierte la pantalla al traducir. */
export type ClaveDeTraduccion = string;

/* -------------------------------------------------------------------------- */
/* Los estados                                                                 */
/* -------------------------------------------------------------------------- */

/** Los dos por los que se filtra: lo que se lee y lo que está escondido. */
export const ESTADOS_QUE_SE_FILTRAN = ['visible', 'hidden'] as const;
export type EstadoQueSeFiltra = (typeof ESTADOS_QUE_SE_FILTRAN)[number];

/** Todos los que la base puede guardar (`resenas.py`: VISIBLE/ESCONDIDA/BORRADOR). */
export const ESTADOS_DE_RESENA = ['visible', 'hidden', 'draft'] as const;

function conocido(valores: readonly string[], valor: string, prefijo: string): string {
  return valores.includes(valor) ? `${prefijo}.${valor}` : `${prefijo}.desconocido`;
}

/** El nombre del estado. Lo que no se conoce se dice desconocido, no se adivina. */
export function claveDelEstadoDeResena(estado: string): ClaveDeTraduccion {
  return conocido(ESTADOS_DE_RESENA, estado, 'moderacionResenas.estado');
}

/** Si este estado es uno de los que el módulo sabe leer. */
export function estadoConocido(estado: string | null | undefined): boolean {
  return typeof estado === 'string' && (ESTADOS_DE_RESENA as readonly string[]).includes(estado);
}

/** Con qué color se pinta. Escondida no es «mala»: es un aviso de que no se lee. */
export function tonoDelEstado(estado: string): 'visible' | 'oculto' | 'neutro' {
  if (estado === 'visible') return 'visible';
  if (estado === 'hidden') return 'oculto';
  return 'neutro';
}

/** Cuántas hay de cada cosa. Para decirlo arriba sin recontar en la pantalla. */
export function contarPorEstado(
  filas: ReadonlyArray<{ status?: string | null }>,
): { visibles: number; ocultas: number; otras: number } {
  let visibles = 0;
  let ocultas = 0;
  let otras = 0;
  for (const fila of filas) {
    if (fila.status === 'visible') visibles += 1;
    else if (fila.status === 'hidden') ocultas += 1;
    else otras += 1;
  }
  return { visibles, ocultas, otras };
}

/* -------------------------------------------------------------------------- */
/* Lo que se puede hacer, que son dos cosas y ninguna borra                    */
/* -------------------------------------------------------------------------- */

/**
 * Las DOS acciones que existen.
 *
 * No hay una tercera. `POST /events/reviews/{id}/moderate` solo acepta
 * `hide: true` o `hide: false`, y no existe ningún `DELETE`.
 */
export const ACCIONES = ['ocultar', 'restaurar'] as const;
export type AccionDeModeracion = (typeof ACCIONES)[number];

/**
 * Qué ofrece este estado. `null` cuando no hay nada que ofrecer.
 *
 * Visible se puede esconder; escondida se puede devolver. Un borrador no está
 * publicado —esconderlo no cambia nada de lo que nadie ve— y un estado que no
 * se conoce no se toca: la pantalla enseña la reseña sin botón.
 */
export function accionQueOfrece(estado: string | null | undefined): AccionDeModeracion | null {
  if (estado === 'visible') return 'ocultar';
  if (estado === 'hidden') return 'restaurar';
  return null;
}

/** El texto del botón. */
export function claveDeAccion(accion: string): ClaveDeTraduccion {
  return conocido(ACCIONES, accion, 'moderacionResenas.accion');
}

/**
 * El `hide` que viaja al servidor. `null` si eso no es una acción.
 *
 * Devolver `false` ante una acción desconocida escondería lo contrario de lo
 * que se pidió, así que se distingue «restaurar» de «no sé qué es esto».
 */
export function valorDeHide(accion: string): boolean | null {
  if (accion === 'ocultar') return true;
  if (accion === 'restaurar') return false;
  return null;
}

/** Ocultar exige motivo. Restaurar no: devuelve algo, no lo quita. */
export function motivoObligatorio(accion: string): boolean {
  return accion === 'ocultar';
}

/* -------------------------------------------------------------------------- */
/* El motivo                                                                   */
/* -------------------------------------------------------------------------- */

/** `ModerarRequest.reason`: `max_length=500` en el servidor. */
export const LARGO_MAXIMO_DEL_MOTIVO = 500;

/** Lo que hay escrito en el motivo, leído. */
export type MotivoRevisado =
  | { estado: 'listo'; motivo: string | null }
  | { estado: 'falta' }
  | { estado: 'largo'; maximo: number };

/**
 * El motivo, comprobado AQUÍ antes de llamar a nadie.
 *
 * El servidor acepta `reason: null` al esconder: si el cliente no lo exige,
 * nadie lo exige, y queda una reseña escondida que nadie puede explicar. Y el
 * tope se mira antes de mandar porque un 422 sobre un texto ya escrito es
 * trabajo tirado.
 */
export function revisarMotivo(
  accion: string,
  texto: string | null | undefined,
  maximo: number = LARGO_MAXIMO_DEL_MOTIVO,
): MotivoRevisado {
  const limpio = (texto ?? '').trim();
  if (limpio === '') {
    return motivoObligatorio(accion) ? { estado: 'falta' } : { estado: 'listo', motivo: null };
  }
  if (limpio.length > maximo) return { estado: 'largo', maximo };
  return { estado: 'listo', motivo: limpio };
}

/** El texto que SÍ se puede mandar, recortado al tope. `null` si no hay nada. */
export function textoUtil(
  texto: string | null | undefined,
  maximo: number = LARGO_MAXIMO_DEL_MOTIVO,
): string | null {
  const limpio = (texto ?? '').trim();
  if (limpio === '') return null;
  return limpio.slice(0, Math.max(0, maximo));
}

/* -------------------------------------------------------------------------- */
/* Lo que se lee de la reseña, y solo se lee                                   */
/* -------------------------------------------------------------------------- */

/** Cuántos caracteres del identificador bastan para reconocerlo en la lista. */
export const LARGO_DE_LA_REFERENCIA = 8;

/**
 * El identificador, acortado para poder mencionarlo.
 *
 * ESTO NO ES UN NOMBRE. La identidad pública de quien escribe no la ha decidido
 * la empresa, y el contrato no manda ningún perfil: `author_id` es una
 * referencia interna con la que investigar, y se enseña como tal en una
 * pantalla interna. `null` cuando no hay nada que enseñar; nunca una cadena
 * inventada.
 */
export function abreviarIdentificador(
  id: string | null | undefined,
  largo: number = LARGO_DE_LA_REFERENCIA,
): string | null {
  const limpio = (id ?? '').trim();
  if (limpio === '') return null;
  const tope = Math.max(1, Math.trunc(largo));
  return limpio.length <= tope ? limpio : `${limpio.slice(0, tope)}…`;
}

/** Si eso es una de las cinco notas que el servidor acepta (`ge=1, le=5`). */
export function puntuacionValida(overall: unknown): boolean {
  return (
    typeof overall === 'number' &&
    Number.isInteger(overall) &&
    overall >= 1 &&
    overall <= 5
  );
}

/**
 * La nota escrita, o `null`.
 *
 * SOLO SE LEE. No hay ninguna función que la cambie, porque moderar no cambia
 * la puntuación de nadie. Y lo que no es una nota válida no se dibuja como si
 * lo fuera: `null`, y la pantalla lo calla.
 */
export function puntuacionLegible(overall: unknown): string | null {
  return puntuacionValida(overall) ? `${overall as number}/5` : null;
}

/** Lo que cabe de un comentario en una fila de la lista. */
export const LARGO_DEL_RESUMEN = 160;

/**
 * El comentario recortado para la lista, SIN cortar una palabra por la mitad.
 *
 * Se corta en el último espacio que quepa, no en el carácter número 160: partir
 * una palabra hace que un texto legítimo parezca otra cosa, y en una pantalla
 * donde se decide qué se esconde eso importa. El texto entero sigue estando en
 * la ficha: esto solo es la fila.
 */
export function resumenDelComentario(
  comentario: string | null | undefined,
  maximo: number = LARGO_DEL_RESUMEN,
): string | null {
  const limpio = (comentario ?? '').replace(/\s+/g, ' ').trim();
  if (limpio === '') return null;
  const tope = Math.max(1, Math.trunc(maximo));
  if (limpio.length <= tope) return limpio;
  const cortado = limpio.slice(0, tope);
  const ultimoEspacio = cortado.lastIndexOf(' ');
  const util = ultimoEspacio > 0 ? cortado.slice(0, ultimoEspacio) : cortado;
  return `${util.trimEnd()}…`;
}

/* -------------------------------------------------------------------------- */
/* El historial: se lee, nunca se edita                                        */
/* -------------------------------------------------------------------------- */

/**
 * Los destinos que el servidor puede haber escrito.
 *
 * **LA ACCIÓN ES EL DESTINO.** El paso no trae un verbo: trae el estado en el
 * que quedó la reseña (`to_status`), y de dónde venía (`from_status`). Llegar a
 * `hidden` es haberla ocultado y llegar a `visible` es haberla restaurado, así
 * que se lee el destino y no se guarda un verbo aparte que pudiera contradecirlo.
 *
 * La tabla `event_review_moderation` solo se añade —lo impone un disparador—,
 * así que aquí no hay ninguna función que modifique un paso: se traduce y se
 * enseña.
 */
export const PASOS_DE_MODERACION = ['visible', 'hidden'] as const;

/** Qué se hizo en ese paso, leído de su destino. Lo raro se dice desconocido. */
export function claveDelPaso(destino: string): ClaveDeTraduccion {
  return conocido(PASOS_DE_MODERACION, destino, 'moderacionResenas.paso');
}

/**
 * La acción que fue ese paso, deducida de su destino. `null` si no se entiende.
 *
 * Es la misma regla que `accionQueOfrece` leída al revés: allí «está visible,
 * luego se puede ocultar»; aquí «acabó oculta, luego se ocultó».
 */
export function accionDelPaso(destino: string | null | undefined): AccionDeModeracion | null {
  if (destino === 'hidden') return 'ocultar';
  if (destino === 'visible') return 'restaurar';
  return null;
}

/* -------------------------------------------------------------------------- */
/* La fila, después de moderarla                                               */
/* -------------------------------------------------------------------------- */

/** Lo que cambia de una fila al moderarla. Nada más de la reseña se toca. */
export type FilaModerada = {
  status: string;
  moderation_reason: string | null;
  moderated_by: string | null;
  moderated_at: string | null;
};

/**
 * La fila repintada con lo que contestó el servidor.
 *
 * EL ESTADO LO MANDA LA RESPUESTA, no lo que creíamos haber hecho. Y lo que la
 * respuesta NO trae no se hereda de antes: `moderated_by` y `moderated_at` de
 * una moderación anterior serían datos viejos contados como nuevos, así que si
 * no vienen se quedan en `null` y la pantalla simplemente se calla esa línea.
 *
 * El motivo es la única excepción, y no es inventarlo: es exactamente el texto
 * que se acaba de mandar y que el servidor acaba de guardar. Al restaurar los
 * tres se vacían, que es literalmente lo que el servidor escribe.
 *
 * NI LA NOTA NI EL AUTOR NI EL COMENTARIO se tocan: se copian de la fila que ya
 * estaba, porque moderar no los cambia.
 */
export function filaTrasModerar<T extends FilaModerada>(
  fila: T,
  respuesta: Partial<FilaModerada> | null | undefined,
  motivoEnviado: string | null,
): T {
  const estado =
    typeof respuesta?.status === 'string' && respuesta.status !== ''
      ? respuesta.status
      : fila.status;
  if (estado === 'hidden') {
    return {
      ...fila,
      status: estado,
      moderation_reason: respuesta?.moderation_reason ?? motivoEnviado ?? null,
      moderated_by: respuesta?.moderated_by ?? null,
      moderated_at: respuesta?.moderated_at ?? null,
    };
  }
  if (estado === 'visible') {
    return {
      ...fila,
      status: estado,
      moderation_reason: null,
      moderated_by: null,
      moderated_at: null,
    };
  }
  return { ...fila, status: estado };
}

/* -------------------------------------------------------------------------- */
/* La lista                                                                    */
/* -------------------------------------------------------------------------- */

/** Los topes que el servidor admite (`limit` de 1 a 200). NO HAY CURSOR. */
export const LIMITES_DE_LA_LISTA = [50, 100, 200] as const;
export const LIMITE_INICIAL = LIMITES_DE_LA_LISTA[0];
export const LIMITE_MAXIMO = 200;

/** El siguiente tope, o `null` si ya estamos en el máximo del servidor. */
export function siguienteLimite(actual: number): number | null {
  for (const limite of LIMITES_DE_LA_LISTA) {
    if (limite > actual) return limite;
  }
  return null;
}

/** Si lo que se ve podría no ser todo: el corte lo puso el `limit`. */
export function llegoAlTope(cuantos: number, limite: number): boolean {
  return cuantos >= limite;
}

/** Un tope que el servidor vaya a aceptar. Lo raro cae en el de partida. */
export function limiteValido(limite: number | null | undefined): number {
  if (typeof limite !== 'number' || !Number.isFinite(limite)) return LIMITE_INICIAL;
  return Math.min(LIMITE_MAXIMO, Math.max(1, Math.trunc(limite)));
}

/** Un identificador de evento escrito a mano, listo para el filtro, o `null`. */
export function filtroDeEvento(texto: string | null | undefined): string | null {
  const limpio = (texto ?? '').trim();
  return limpio === '' ? null : limpio;
}

/**
 * La cola de `GET /admin/events/reviews`.
 *
 * Siempre con `limit`, para que el tope sea explícito y la pantalla pueda
 * decirlo. `estado` y `event_id` solo viajan si hay algo que filtrar: mandarlos
 * vacíos filtraría por la cadena vacía.
 */
export function cadenaDeFiltros(opciones?: {
  estado?: string | null;
  eventoId?: string | null;
  limite?: number | null;
}): string {
  const partes = [`limit=${limiteValido(opciones?.limite)}`];
  const estado = (opciones?.estado ?? '').trim();
  if (estado !== '') partes.push(`estado=${encodeURIComponent(estado)}`);
  const evento = filtroDeEvento(opciones?.eventoId);
  if (evento !== null) partes.push(`event_id=${encodeURIComponent(evento)}`);
  return partes.join('&');
}

/* -------------------------------------------------------------------------- */
/* Cuando el servidor dice que no                                              */
/* -------------------------------------------------------------------------- */

/** Alguien moderó la misma reseña mientras decidías. Se recarga y se vuelve. */
export function esConflictoDeResena(codigo: string | null | undefined): boolean {
  return codigo === 'event_review_changed';
}

/** Las reseñas todavía no están disponibles (503 con código estable). */
export function esResenasApagadas(codigo: string | null | undefined): boolean {
  return codigo === 'event_reviews_not_available';
}

/**
 * El filtro de estado que se pidió no vale (422).
 *
 * Es distinto de «no hay ninguna»: antes un estado inventado devolvía la lista
 * vacía y quien miraba leía que no había reseñas. Ahora el servidor lo rechaza
 * y aquí se dice que el filtro está mal, no que no haya nada.
 */
export function esEstadoDeFiltroInvalido(codigo: string | null | undefined): boolean {
  return codigo === 'event_review_status_invalid';
}

/**
 * Los códigos de esta pantalla, traducidos. `null` = no lo conozco.
 *
 * Sin clave se usa el mensaje del servidor, que en español es correcto.
 */
export function claveDeErrorDeModeracion(
  codigo: string | null | undefined,
): ClaveDeTraduccion | null {
  const conocidos: Record<string, string> = {
    event_review_changed: 'moderacionResenas.conflictoCuerpo',
    event_review_not_found: 'moderacionResenas.error.noEncontrada',
    event_reviews_not_available: 'moderacionResenas.error.noDisponible',
    event_review_status_invalid: 'moderacionResenas.falloCuerpo.estadoInvalido',
  };
  if (typeof codigo !== 'string') return null;
  return conocidos[codigo] ?? null;
}

/** Lo que hay que enseñar cuando la carga falla. Cada caso se dice distinto. */
export type FalloDeCarga =
  | 'sinSesion'
  | 'sinPermiso'
  | 'noDisponible'
  | 'noEncontrada'
  | 'estadoInvalido'
  | 'datosInvalidos'
  | 'sinConexion'
  | 'red';

/** Los fallos que tienen titular y explicación propios. */
const FALLOS_CON_TEXTO = [
  'sinSesion',
  'sinPermiso',
  'noDisponible',
  'noEncontrada',
  'estadoInvalido',
  'datosInvalidos',
] as const;

/**
 * El 401, el 403, el 404, el 409, el 422 y la red, separados.
 *
 * NO SE JUNTAN. «No has iniciado sesión» y «esto no es para ti» piden cosas
 * distintas a quien lo lee, y un corte de red se reintenta mientras que un 403
 * no. Un 409 no llega aquí: lo trata el conflicto, que recarga.
 *
 * EL CÓDIGO MANDA SOBRE EL NÚMERO. Un 422 puede ser «el filtro de estado no
 * vale» —que se arregla tocando un chip— o cualquier otra cosa; el código lo
 * distingue y el número solo no.
 */
export function falloDeCarga(
  estadoHttp: number | null | undefined,
  codigo: string | null | undefined,
): FalloDeCarga {
  if (esResenasApagadas(codigo)) return 'noDisponible';
  if (esEstadoDeFiltroInvalido(codigo)) return 'estadoInvalido';
  if (codigo === 'network_error' || codigo === 'timeout') return 'sinConexion';
  if (estadoHttp === 401) return 'sinSesion';
  if (estadoHttp === 403) return 'sinPermiso';
  if (estadoHttp === 404) return 'noEncontrada';
  if (estadoHttp === 422) return 'datosInvalidos';
  if (estadoHttp === 503) return 'noDisponible';
  return 'red';
}

/** El titular de ese fallo. */
export function claveDelFallo(fallo: string): ClaveDeTraduccion {
  return conocido(FALLOS_CON_TEXTO, fallo, 'moderacionResenas.fallo');
}

/** La explicación de ese fallo: qué pasa y qué se puede hacer. */
export function claveDelCuerpoDelFallo(fallo: string): ClaveDeTraduccion {
  return conocido(FALLOS_CON_TEXTO, fallo, 'moderacionResenas.falloCuerpo');
}

/** Si ese fallo tiene sentido reintentarlo. Un permiso denegado no lo tiene. */
export function seReintenta(fallo: string): boolean {
  return fallo === 'red' || fallo === 'sinConexion';
}
