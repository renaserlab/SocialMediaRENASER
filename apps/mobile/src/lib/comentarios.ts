/**
 * La lista de comentarios de una publicación: qué entra, qué sale y cuántos hay.
 *
 * VIVE APARTE DE LA PANTALLA porque los tres fallos que arregla no se ven
 * montando la vista, se ven en la secuencia de estados:
 *
 *   1. UN COMENTARIO RECHAZADO SE QUEDABA EN PANTALLA. Ante un 404 la pantalla
 *      conservaba el comentario optimista a propósito («por si era un short»).
 *      El resultado es lo peor que puede hacer esta aplicación: enseñar como
 *      guardado algo que el servidor rechazó. Se quedaba hasta recargar, y al
 *      recargar desaparecía sin explicación. Aquí no hay excepciones por
 *      código de error: si el servidor no lo aceptó, no se enseña.
 *
 *   2. EL COMENTARIO SALÍA DOS VECES. Al llegar la respuesta real se sustituía
 *      el optimista por ella, pero si entre medias había entrado una recarga
 *      con el comentario ya dentro, quedaban los dos: el mismo texto repetido.
 *
 *   3. EL CONTADOR SE DESCUADRABA. Subía al escribir y no bajaba al fallar.
 *
 * Todo se identifica por `id`, no por texto: dos personas pueden escribir lo
 * mismo, y la misma persona puede repetirse.
 */

/** Lo mínimo que hace falta para ordenar y deduplicar. */
export type ConId = { id: string };

export type EstadoDeComentarios<T extends ConId> = {
  /** Del más reciente al más antiguo, que es como llegan del servidor. */
  lista: T[];
  /**
   * Cuántos hay EN TOTAL, no cuántos se han cargado. Es el número que ve quien
   * vuelve al muro, así que sube y baja con lo que el servidor acepta.
   */
  total: number;
  /** Cursor de la última página traída; null cuando ya no queda nada. */
  cursor: Cursor | null;
};

/** Punto exacto por el que sigue la página siguiente. */
export type Cursor = { createdAt: string; id: string };

export function estadoInicial<T extends ConId>(total = 0): EstadoDeComentarios<T> {
  return { lista: [], total, cursor: null };
}

/**
 * Añade una página respetando lo que ya había.
 *
 * Descarta por id lo que ya está en la lista: dos páginas pueden solaparse si
 * alguien comenta mientras se lee, y un comentario repetido en el listado es
 * indistinguible de dos comentarios iguales.
 *
 * `total` solo sube: si lo cargado supera al contador que traía el muro, es el
 * contador el que estaba viejo.
 */
export function anadirPagina<T extends ConId>(
  estado: EstadoDeComentarios<T>,
  llegan: readonly T[],
  cursor: Cursor | null,
): EstadoDeComentarios<T> {
  const conocidos = new Set(estado.lista.map((c) => c.id));
  const nuevos = llegan.filter((c) => !conocidos.has(c.id));
  const lista = [...estado.lista, ...nuevos];
  return { lista, total: Math.max(estado.total, lista.length), cursor };
}

/** Reemplaza la lista entera (primera carga o recarga tras un fallo). */
export function primeraPagina<T extends ConId>(
  llegan: readonly T[],
  cursor: Cursor | null,
  totalConocido?: number,
): EstadoDeComentarios<T> {
  const lista = deduplicar(llegan);
  return { lista, total: Math.max(totalConocido ?? 0, lista.length), cursor };
}

/**
 * El comentario aún sin confirmar, arriba del todo.
 *
 * Sube el contador porque quien acaba de escribir espera verlo subir. Si el
 * servidor lo rechaza, `descartarOptimista` lo devuelve donde estaba: el
 * contador nunca se queda contando algo que no existe.
 */
export function conOptimista<T extends ConId>(
  estado: EstadoDeComentarios<T>,
  optimista: T,
): EstadoDeComentarios<T> {
  return {
    ...estado,
    lista: [optimista, ...estado.lista],
    total: estado.total + 1,
  };
}

/**
 * El servidor lo guardó: se cambia el provisional por el de verdad.
 *
 * Si el real YA estaba en la lista (una recarga se adelantó a la respuesta),
 * se quita el provisional y no se añade nada. Sin esto el comentario aparece
 * dos veces, que es el punto 3 de la cabecera.
 *
 * El total no se toca: ya subió al pintar el optimista.
 */
export function confirmarOptimista<T extends ConId>(
  estado: EstadoDeComentarios<T>,
  idOptimista: string,
  real: T,
): EstadoDeComentarios<T> {
  const yaEstaba = estado.lista.some((c) => c.id === real.id && c.id !== idOptimista);
  const lista = yaEstaba
    ? estado.lista.filter((c) => c.id !== idOptimista)
    : estado.lista.map((c) => (c.id === idOptimista ? real : c));
  return { ...estado, lista, total: Math.max(lista.length, estado.total) };
}

/**
 * El servidor NO lo guardó: fuera, sin mirar por qué.
 *
 * Da igual que sea un 404, un 401, un 500 o que no hubiera red. Ninguno de
 * esos casos significa «guardado», y la única forma de que la pantalla no
 * mienta es no distinguirlos.
 */
export function descartarOptimista<T extends ConId>(
  estado: EstadoDeComentarios<T>,
  idOptimista: string,
): EstadoDeComentarios<T> {
  const lista = estado.lista.filter((c) => c.id !== idOptimista);
  // Nunca por debajo de lo que se está enseñando, ni por debajo de cero.
  return { ...estado, lista, total: Math.max(lista.length, estado.total - 1) };
}

/** Marca de un comentario que todavía no ha confirmado el servidor. */
const PREFIJO_OPTIMISTA = 'pendiente-';

export function idOptimista(semilla: number = Date.now()): string {
  return `${PREFIJO_OPTIMISTA}${semilla}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Un comentario sin confirmar no se puede usar como cursor ni reenviar. */
export function esOptimista(id: string): boolean {
  return id.startsWith(PREFIJO_OPTIMISTA);
}

/** Por qué no se publicó, cuando no se publicó. */
export type MotivoDeFallo = 'sin-sesion' | 'servidor';

export type ResultadoDeEnvio<T extends ConId> = {
  estado: EstadoDeComentarios<T>;
  /** Lo que tiene que quedar en el campo de texto DESPUÉS del intento. */
  texto: string;
  /** Cuánto mover el contador de la publicación en el muro: 1 o 0. Nunca a ciegas. */
  delta: number;
  fallo: MotivoDeFallo | null;
};

/**
 * Publicar un comentario, de principio a fin.
 *
 * Está aquí y no en la pantalla porque es la secuencia entera lo que se
 * equivocaba, no una línea suelta, y una secuencia se puede probar; una
 * pantalla de React Native, en este proyecto, no.
 *
 * EL ORDEN IMPORTA Y ES EL SIGUIENTE:
 *
 *   1. Se pide la sesión ANTES de tocar nada. Quien no tiene cuenta ve el aviso
 *      con su texto todavía escrito; antes se le vaciaba el campo primero y,
 *      si decidía no registrarse, había perdido lo que estaba escribiendo.
 *   2. Solo entonces aparece el comentario optimista y se vacía el campo.
 *   3. Si el servidor falla —el motivo da igual— el comentario se retira, el
 *      contador vuelve y el texto se devuelve al campo para poder reintentar.
 */
export async function enviarComentario<T extends ConId>({
  estado,
  texto,
  autorizar,
  crear,
  optimista,
}: {
  estado: EstadoDeComentarios<T>;
  texto: string;
  /** Resuelve a false si no hay cuenta y no se llegó a crear. */
  autorizar: () => Promise<boolean>;
  crear: (texto: string) => Promise<T>;
  /** Cómo se pinta el comentario mientras el servidor responde. */
  optimista: (texto: string, id: string) => T;
}): Promise<ResultadoDeEnvio<T>> {
  const limpio = texto.trim();
  if (!limpio) return { estado, texto, delta: 0, fallo: null };

  if (!(await autorizar())) {
    return { estado, texto, delta: 0, fallo: 'sin-sesion' };
  }

  const provisional = optimista(limpio, idOptimista());
  const conElOptimista = conOptimista(estado, provisional);
  try {
    const guardado = await crear(limpio);
    return {
      estado: confirmarOptimista(conElOptimista, provisional.id, guardado),
      texto: '',
      delta: 1,
      fallo: null,
    };
  } catch {
    return {
      estado: descartarOptimista(conElOptimista, provisional.id),
      texto,
      delta: 0,
      fallo: 'servidor',
    };
  }
}

function deduplicar<T extends ConId>(items: readonly T[]): T[] {
  const vistos = new Set<string>();
  const salida: T[] = [];
  for (const item of items) {
    if (vistos.has(item.id)) continue;
    vistos.add(item.id);
    salida.push(item);
  }
  return salida;
}
