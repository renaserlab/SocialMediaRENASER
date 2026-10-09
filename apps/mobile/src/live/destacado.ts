/**
 * Lo destacado de un directo: el mensaje fijado y el rótulo de quien emite.
 *
 * LO QUE SE PIDIÓ (07/10/2026): que quien emite pueda FIJAR un mensaje del
 * chat —para que no se lo lleve la conversación y lo vea también quien entra
 * después— y poner un TEXTO PROPIO sobre la imagen, a la vista de todos.
 *
 * LO DECIDE EL SERVIDOR. Aquí no hay ningún permiso: cada gesto es una
 * petición, y lo que se pinta es lo que el servidor contesta. Las reglas de
 * allí están en `apps/api/app/modules/live/destacado.py`.
 *
 * Aquí vive lo que se puede probar sin React, sin red y sin teléfono: leer la
 * respuesta, limpiar y medir el rótulo igual que el servidor, qué acciones
 * tiene un mensaje para quien modera, cómo se cuenta un fallo y cuándo se
 * vuelve a preguntar. Sin importaciones, a propósito.
 */

/* ------------------------------------------------------------------------- *
 * EL RÓTULO
 * ------------------------------------------------------------------------- */

/**
 * Cómo se mueve el rótulo. Coincide con `ESTILOS` del servidor y con el CHECK
 * de `live_spotlights` (migración 0099).
 *
 *   · `slide`  — entra deslizándose y se queda quieto.
 *   · `pulse`  — entra y late un par de veces, para un aviso.
 *   · `ticker` — corre de lado, para un texto que no cabe a lo ancho.
 */
export const ESTILOS_DE_ROTULO = ['slide', 'pulse', 'ticker'] as const;
export type EstiloDeRotulo = (typeof ESTILOS_DE_ROTULO)[number];
export const ESTILO_POR_OMISION: EstiloDeRotulo = 'slide';

/** Tope del rótulo, en caracteres. El mismo que el servidor y que la base. */
export const MAXIMO_DE_ROTULO = 80;

export type Rotulo = {
  texto: string;
  estilo: EstiloDeRotulo;
  /** Cuándo se puso. Con el texto y el estilo, dice si es OTRO rótulo. */
  puestoEnIso: string | null;
};

function esEstilo(valor: unknown): valor is EstiloDeRotulo {
  return typeof valor === 'string' && (ESTILOS_DE_ROTULO as readonly string[]).includes(valor);
}

/** El unidor de ancho cero: mantiene juntos los emojis compuestos. */
const UNIDOR = '‍';

/**
 * El rótulo tal y como lo va a guardar el servidor: una línea, sin relleno.
 *
 * ES LA MISMA LIMPIEZA QUE HACE EL SERVIDOR (`destacado.limpiar_rotulo`), y
 * tiene que serlo: el contador que ve quien escribe cuenta sobre esto, y si
 * contara otra cosa diría «cabe» de un texto que el servidor va a rechazar.
 *
 * Los saltos, las tabulaciones y cualquier espacio raro pasan a ser un espacio;
 * los caracteres de formato invisibles —un «cero de ancho», las marcas que dan
 * la vuelta al texto— se quitan, salvo el unidor de los emojis; y los espacios
 * seguidos se quedan en uno.
 */
export function limpiarRotulo(texto: string): string {
  let visible = '';
  for (const caracter of texto) {
    if (/[\p{Zl}\p{Zp}\p{Zs}\p{Cc}]/u.test(caracter)) visible += ' ';
    else if (/\p{Cf}/u.test(caracter) && caracter !== UNIDOR) continue;
    else visible += caracter;
  }
  return visible.replace(/ +/g, ' ').trim();
}

/**
 * Cuánto mide un rótulo, contado como lo cuenta el servidor: por caracteres,
 * no por unidades de UTF-16. Un emoji es UNO aquí y dos en `.length`; con
 * `.length` el contador diría «te has pasado» a ochenta emojis que caben.
 */
export function largoDelRotulo(limpio: string): number {
  return Array.from(limpio).length;
}

/** Si hay algo que se VE: letra, número, signo o símbolo. */
export function diceAlgo(texto: string): boolean {
  return /[\p{L}\p{N}\p{P}\p{S}]/u.test(texto);
}

export type JuicioDelRotulo =
  /** Se puede mandar. */
  | 'vale'
  /** No hay nada escrito, o nada que se vea. */
  | 'vacio'
  /** Pasa del tope. */
  | 'largo';

/** Lo que se le dice a quien escribe ANTES de mandar nada. */
export function juzgarRotulo(texto: string): JuicioDelRotulo {
  const limpio = limpiarRotulo(texto);
  if (limpio === '' || !diceAlgo(limpio)) return 'vacio';
  return largoDelRotulo(limpio) > MAXIMO_DE_ROTULO ? 'largo' : 'vale';
}

/**
 * Lo que identifica a un rótulo EN PANTALLA.
 *
 * Su entrada se anima cuando esto cambia, y solo entonces: releer el mismo
 * rótulo —cada vez que llega un aviso, cada vez que se vuelve a la sala— no
 * puede hacerlo entrar otra vez. Quitar un rótulo y volver a poner el mismo
 * texto SÍ es otro: cambia su fecha.
 */
export function claveDelRotulo(rotulo: Rotulo | null): string {
  if (!rotulo) return '';
  return `${rotulo.puestoEnIso ?? ''}|${rotulo.estilo}|${rotulo.texto}`;
}

/* ------------------------------------------------------------------------- *
 * LEER LO QUE MANDA EL SERVIDOR
 * ------------------------------------------------------------------------- */

export type Destacado<Mensaje> = {
  fijado: Mensaje | null;
  rotulo: Rotulo | null;
  /** Si quien pregunta puede fijar y poner rótulo. */
  puedeGestionar: boolean;
};

export function destacadoVacio<Mensaje>(): Destacado<Mensaje> {
  return { fijado: null, rotulo: null, puedeGestionar: false };
}

/** El rótulo, o `null` si aquello no lo es o viene vacío. */
export function leerRotulo(bruto: unknown): Rotulo | null {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return null;
  const dto = bruto as Record<string, unknown>;
  if (typeof dto.text !== 'string' || dto.text.trim() === '') return null;
  return {
    texto: dto.text,
    // Un estilo que esta versión no conoce se pinta como el de siempre: un
    // servidor más nuevo no puede dejar a nadie sin ver el rótulo.
    estilo: esEstilo(dto.style) ? dto.style : ESTILO_POR_OMISION,
    puestoEnIso: typeof dto.set_at === 'string' && dto.set_at !== '' ? dto.set_at : null,
  };
}

/** Lo mínimo para que algo sea un mensaje del chat que se pueda pintar. */
export function pareceUnMensaje(bruto: unknown): boolean {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return false;
  const dto = bruto as Record<string, unknown>;
  return (
    typeof dto.id === 'string' &&
    dto.id !== '' &&
    typeof dto.user_id === 'string' &&
    typeof dto.body === 'string' &&
    dto.body !== '' &&
    // Un mensaje escondido no se enseña fijado. El servidor ya no lo manda;
    // si un día lo mandara, tampoco se pinta.
    dto.hidden !== true
  );
}

/**
 * De lo que manda el servidor a lo que usa la pantalla.
 *
 * `null` si aquello no es la respuesta de lo destacado (un 200 con otra cosa
 * dentro: contrato roto, no «no hay nada destacado»). `aMensaje` convierte el
 * mensaje fijado a la forma de la aplicación; se recibe de fuera para que este
 * módulo siga sin importar nada.
 */
export function leerDestacado<Mensaje>(
  bruto: unknown,
  aMensaje: (dto: never) => Mensaje,
): Destacado<Mensaje> | null {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return null;
  const dto = bruto as Record<string, unknown>;
  // Las dos claves vienen SIEMPRE, a nulo cuando no hay nada: es lo que
  // distingue esta respuesta de cualquier otro objeto.
  if (!('pinned' in dto) || !('banner' in dto)) return null;
  return {
    fijado: pareceUnMensaje(dto.pinned) ? aMensaje(dto.pinned as never) : null,
    rotulo: leerRotulo(dto.banner),
    puedeGestionar: dto.can_manage === true,
  };
}

/* ------------------------------------------------------------------------- *
 * QUÉ SE PUEDE HACER CON UN MENSAJE
 * ------------------------------------------------------------------------- */

export type AccionDeMensaje = 'fijar' | 'soltar' | 'ocultar';

/**
 * Las acciones de un mensaje del chat para quien lo mantiene pulsado, en el
 * orden en que se enseñan.
 *
 * - Sin poder moderar no hay ninguna: quien mira no tiene menú.
 * - Fijar o dejar de fijar solo si el servidor admite destacar (sin la
 *   migración 0099 no hay dónde guardarlo). El mensaje que ya está fijado
 *   ofrece soltarlo, no fijarlo otra vez.
 * - Ocultar va siempre lo último: es lo que no se deshace.
 */
export function accionesDeMensaje(estado: {
  puedeModerar: boolean;
  puedeDestacar: boolean;
  mensajeId: string;
  fijadoId: string | null;
}): AccionDeMensaje[] {
  if (!estado.puedeModerar) return [];
  const acciones: AccionDeMensaje[] = [];
  if (estado.puedeDestacar) {
    acciones.push(estado.fijadoId === estado.mensajeId ? 'soltar' : 'fijar');
  }
  acciones.push('ocultar');
  return acciones;
}

/* ------------------------------------------------------------------------- *
 * EL AVISO DE «LO DESTACADO CAMBIÓ»
 * ------------------------------------------------------------------------- */

/** El tópico de difusión. El MISMO en todos los teléfonos de la sala. */
export function topicoDeDestacado(emisionId: string): string {
  return `live-destacado:${emisionId}`;
}

/**
 * Lo que viaja en el aviso: nada. Ni el texto ni el mensaje.
 *
 * EL AVISO NO TIENE AUTORIDAD. El canal es público: lo puede mandar cualquiera
 * con la clave pública de la aplicación. Si llevara el rótulo dentro, cualquiera
 * pondría su texto en la pantalla de toda la sala. Lo único que consigue es que
 * se le pregunte al servidor.
 */
export function avisoDeDestacado(): { v: 1 } {
  return { v: 1 };
}

/* ------------------------------------------------------------------------- *
 * CUÁNDO SE VUELVE A PREGUNTAR
 * ------------------------------------------------------------------------- */

export type Repaso = {
  /** «Puede que haya cambiado»: pregunta, pero no más de una vez por espera. */
  pedir: () => void;
  /** Pregunta ya, sin mirar cuándo fue la última. Para la entrada a la sala. */
  ahoraMismo: () => void;
  destruir: () => void;
};

/**
 * Las preguntas al servidor, con medida.
 *
 * POR QUÉ HACE FALTA. Un aviso hace preguntar a TODOS los teléfonos de la sala,
 * y el aviso lo puede mandar cualquiera. Sin esto, un bucle de avisos falsos
 * convertiría a cien espectadores en cien peticiones por aviso. Con esto, cada
 * teléfono pregunta como mucho una vez por `esperaMs`, y lo que llegue entre
 * medias se junta en UNA pregunta al final de la espera —la última, que es la
 * que trae lo vigente—.
 *
 * Nunca hay dos preguntas a la vez: si llega un aviso con una en vuelo, se
 * apunta y se pregunta otra vez al volver. Sin eso, la respuesta vieja podría
 * llegar después de la nueva y pisarla.
 */
export function crearRepaso(entorno: {
  /** Pregunta y pinta. No rechaza: quien lo implementa cuenta sus fallos. */
  leer: () => Promise<void>;
  esperaMs: number;
  programar: (fn: () => void, ms: number) => () => void;
  ahora: () => number;
}): Repaso {
  let ultima = Number.NEGATIVE_INFINITY;
  let enVuelo = false;
  let pendiente = false;
  let cancelarEspera: (() => void) | null = null;
  let destruido = false;

  function lanzar(): void {
    if (destruido) return;
    if (cancelarEspera) {
      cancelarEspera();
      cancelarEspera = null;
    }
    if (enVuelo) {
      pendiente = true;
      return;
    }
    ultima = entorno.ahora();
    enVuelo = true;
    const alVolver = () => {
      enVuelo = false;
      if (destruido || !pendiente) return;
      pendiente = false;
      pedir();
    };
    entorno.leer().then(alVolver, alVolver);
  }

  function pedir(): void {
    if (destruido) return;
    if (enVuelo) {
      pendiente = true;
      return;
    }
    if (cancelarEspera) return; // ya hay una pregunta esperando su turno
    const falta = ultima + entorno.esperaMs - entorno.ahora();
    if (falta <= 0) {
      lanzar();
      return;
    }
    cancelarEspera = entorno.programar(() => {
      cancelarEspera = null;
      lanzar();
    }, falta);
  }

  return {
    pedir,
    ahoraMismo: lanzar,
    destruir() {
      destruido = true;
      if (cancelarEspera) cancelarEspera();
      cancelarEspera = null;
    },
  };
}

/* ------------------------------------------------------------------------- *
 * CÓMO SE CUENTA UN FALLO
 * ------------------------------------------------------------------------- */

/** Código del servidor → clave del texto que lo explica. */
const TEXTO_DEL_FALLO: Record<string, string> = {
  live_spotlight_closed: 'live.spotlightClosed',
  live_spotlight_rate_limited: 'live.spotlightTooFast',
  live_spotlight_not_available: 'live.spotlightUnavailable',
  live_message_hidden: 'live.pinHidden',
};

/**
 * La clave de `i18n` que explica un fallo de lo destacado, o `null` si el
 * código no es de los suyos y hay que contarlo de la forma general.
 */
export function claveDelFalloDeDestacado(codigo: string | null | undefined): string | null {
  if (!codigo) return null;
  return Object.prototype.hasOwnProperty.call(TEXTO_DEL_FALLO, codigo)
    ? (TEXTO_DEL_FALLO[codigo] as string)
    : null;
}

/**
 * ¿Este fallo significa «en este servidor no se puede destacar»?
 *
 * Es lo que hace que la aplicación NO enseñe las opciones: el servidor todavía
 * no tiene la tabla (503 con su código) o es anterior a la función (404).
 * Cualquier otro fallo —la red, un 500— no dice eso y no puede esconderlas.
 */
export function sinDestacado(fallo: { status?: number; code?: string | null } | null): boolean {
  if (!fallo) return false;
  return fallo.code === 'live_spotlight_not_available' || fallo.status === 404;
}
