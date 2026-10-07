/**
 * EL ESCENARIO DE UN DIRECTO: quién sale en pantalla además de quien emite.
 *
 * Pedido el 07/10/2026, como en TikTok: quien emite invita a otras personas,
 * estas salen con su cámara y la pantalla se reparte entre todos.
 *
 * AQUÍ SOLO HAY REGLAS, y ninguna importa nada —ni React Native ni la red—
 * para que se puedan ejecutar en las pruebas:
 *
 *   - leer lo que contesta el servidor (`leerEscenario`);
 *   - qué imágenes se pintan y en qué orden (`elegirPistasDeEscenario`);
 *   - cómo se reparte la pantalla (`repartoDeEscenario`);
 *   - a quién le incumbe un aviso de «el escenario cambió» (`meTocaElAviso`).
 *
 * QUIÉN DECIDE. El servidor, siempre: invitar, aceptar y bajarse son
 * peticiones suyas, y el permiso de publicar va firmado en la credencial que
 * él entrega. Lo de aquí solo dice cómo se ENSEÑA lo que él ya decidió.
 */

/** Lo último que pasó con una persona invitada. Los del servidor, tal cual. */
export const ESTADOS_DE_INVITACION = ['invited', 'accepted', 'declined', 'left', 'removed'] as const;
export type EstadoDeInvitacion = (typeof ESTADOS_DE_INVITACION)[number];

export type Invitado = {
  usuarioId: string;
  nombre: string;
  usuario: string | null;
  avatarPath: string | null;
  estado: EstadoDeInvitacion;
};

export type Escenario = {
  /** Cuántas personas invitadas caben a la vez, además de quien emite. */
  maximo: number;
  /** Si quien pregunta puede invitar ahora mismo. */
  puedeInvitar: boolean;
  /** Para quien gestiona, a quién invitó; para el resto, quién está arriba. */
  invitados: Invitado[];
  /** Lo que le pasa a QUIEN PREGUNTA. `null` = nunca se le invitó. */
  mio: EstadoDeInvitacion | null;
};

export function escenarioVacio(): Escenario {
  return { maximo: 0, puedeInvitar: false, invitados: [], mio: null };
}

function esEstado(valor: unknown): valor is EstadoDeInvitacion {
  return typeof valor === 'string' && (ESTADOS_DE_INVITACION as readonly string[]).includes(valor);
}

/**
 * De lo que manda el servidor a lo que usa la pantalla.
 *
 * `null` si aquello no es un escenario. Una fila que no se entiende se
 * DESCARTA en vez de tumbar la lista entera: un estado nuevo en el servidor no
 * puede dejar a quien emite sin ver a sus invitados.
 */
export function leerEscenario(bruto: unknown): Escenario | null {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return null;
  const dto = bruto as Record<string, unknown>;
  if (!Array.isArray(dto.guests)) return null;

  const invitados: Invitado[] = [];
  for (const fila of dto.guests) {
    if (!fila || typeof fila !== 'object') continue;
    const f = fila as Record<string, unknown>;
    if (typeof f.user_id !== 'string' || f.user_id === '' || !esEstado(f.status)) continue;
    invitados.push({
      usuarioId: f.user_id,
      nombre: typeof f.name === 'string' ? f.name : '',
      usuario: typeof f.username === 'string' && f.username !== '' ? f.username : null,
      avatarPath: typeof f.avatar_path === 'string' && f.avatar_path !== '' ? f.avatar_path : null,
      estado: f.status,
    });
  }

  const maximo = dto.max_guests;
  return {
    maximo: typeof maximo === 'number' && Number.isFinite(maximo) && maximo > 0 ? Math.floor(maximo) : 0,
    puedeInvitar: dto.can_invite === true,
    invitados,
    mio: esEstado(dto.me) ? dto.me : null,
  };
}

/** Quién ocupa sitio: quien está arriba y quien todavía puede aceptar. */
export function ocupaPlaza(estado: EstadoDeInvitacion): boolean {
  return estado === 'invited' || estado === 'accepted';
}

/** Cuántas personas más se pueden invitar ahora. Nunca negativo. */
export function plazasLibres(escenario: Escenario): number {
  const ocupadas = escenario.invitados.filter((invitado) => ocupaPlaza(invitado.estado)).length;
  return Math.max(0, escenario.maximo - ocupadas);
}

/* ------------------------------------------------------------------------- *
 * QUÉ SE PINTA
 * ------------------------------------------------------------------------- */

/** Lo que hace falta saber de una imagen para colocarla. */
export type PistaDeEscenario = {
  id: string;
  local: boolean;
  papel: string;
  silenciada: boolean;
  nombre?: string;
};

/**
 * Cuántas imágenes caben como mucho: quien emite y tres personas más.
 *
 * Cada una es un vídeo que el teléfono de TODO el que mira descarga y
 * decodifica a la vez. Cuatro es lo que un teléfono corriente mueve sin
 * calentarse, y es también lo que el servidor deja invitar (`LIVE_MAX_GUESTS`).
 */
export const MAXIMO_EN_PANTALLA = 4;

/** Los papeles que salen en pantalla: quien emite y quien fue invitado. */
const EN_ESCENA: readonly string[] = ['host', 'guest'];

const esDeQuienEmite = (pista: PistaDeEscenario): boolean => pista.papel === 'host';

/**
 * Las imágenes que se pintan, en su orden.
 *
 * UNA SOLA PERSONA: exactamente lo de siempre. Quien publica se ve a sí mismo;
 * quien mira ve a quien emite. Y si esa única cámara está apagada no se pinta
 * nada —devuelve vacío— para que la pantalla ponga su cartel, como hasta ahora.
 *
 * VARIAS: quien emite primero y los demás detrás, ordenados por su
 * identificador. El orden no puede depender de en qué orden llegó cada uno a
 * ESTE teléfono: entonces cada espectador vería a la gente colocada de una
 * forma distinta, y «la de la derecha» no significaría lo mismo para todos.
 *
 * Con varias personas, la que apaga la cámara NO desaparece: se queda su
 * recuadro —la pantalla lo pinta con su nombre—. Si desapareciera, las demás
 * saltarían de sitio cada vez que alguien tapa la cámara un momento.
 *
 * Solo cuentan quien emite y los invitados. Administración entra en las salas
 * con permiso de moderar; no es parte de la emisión y no se le da recuadro.
 */
export function elegirPistasDeEscenario(
  pistas: readonly PistaDeEscenario[],
  { emito }: { emito: boolean },
): PistaDeEscenario[] {
  const validas = pistas.filter((pista) => pista.id !== '');
  const enEscena = validas.filter(
    // Lo propio siempre cuenta para quien publica: es su cámara.
    (pista) => EN_ESCENA.includes(pista.papel) || (emito && pista.local),
  );

  if (enEscena.length <= 1) {
    const unica = enEscena[0];
    if (unica && !unica.silenciada) return [unica];
    if (emito) return [];
    // Quien mira y no encuentra a nadie con papel conocido: lo de antes, la
    // primera imagen ajena que haya. Una plantilla con otros nombres de rol no
    // puede dejar la pantalla en negro.
    const ajena = validas.find((pista) => !pista.local && !pista.silenciada);
    return unica ? [] : ajena ? [ajena] : [];
  }

  const ordenadas = [...enEscena].sort((a, b) => {
    if (esDeQuienEmite(a) !== esDeQuienEmite(b)) return esDeQuienEmite(a) ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return ordenadas.slice(0, MAXIMO_EN_PANTALLA);
}

/**
 * Cómo se reparte la pantalla: cuántos recuadros lleva cada COLUMNA.
 *
 *   1 → [1]      una imagen, a pantalla completa
 *   2 → [1, 1]   dos columnas, una al lado de otra
 *   3 → [1, 2]   quien emite a la izquierda, a lo alto; los otros dos, uno
 *                encima de otro a la derecha
 *   4 → [2, 2]   cuadrícula
 *
 * EN COLUMNAS Y NO EN FILAS, a propósito. Cada teléfono manda su cámara en
 * vertical. Dos imágenes una ENCIMA de otra darían dos franjas apaisadas, y
 * para rellenarlas habría que recortar cada vídeo por arriba y por abajo: se
 * quedaría el pecho y se iría la cara. Lado a lado cada recuadro sigue siendo
 * alto y lo que se recorta son los lados, donde no hay nadie.
 */
export function repartoDeEscenario(cuantas: number): number[] {
  const n = Math.max(0, Math.min(MAXIMO_EN_PANTALLA, Math.floor(cuantas)));
  if (n <= 0) return [];
  if (n === 1) return [1];
  if (n === 2) return [1, 1];
  if (n === 3) return [1, 2];
  return [2, 2];
}

/** Las imágenes ya repartidas: una lista por columna, en su orden. */
export function repartirEnColumnas<T>(pistas: readonly T[]): T[][] {
  const columnas: T[][] = [];
  let desde = 0;
  for (const cuantas of repartoDeEscenario(pistas.length)) {
    columnas.push(pistas.slice(desde, desde + cuantas));
    desde += cuantas;
  }
  return columnas;
}

/* ------------------------------------------------------------------------- *
 * EL AVISO DE «EL ESCENARIO CAMBIÓ»
 * ------------------------------------------------------------------------- */

/** El tópico de difusión. El MISMO en todos los teléfonos de la sala. */
export function topicoDeEscenario(emisionId: string): string {
  return `live-escenario:${emisionId}`;
}

/** Lo que viaja en el aviso: a quién le incumbe. Nada más. */
export function avisoDeEscenario(paraUsuarioId: string | null): { v: 1; para: string | null } {
  return { v: 1, para: paraUsuarioId };
}

/**
 * ¿Tengo que volver a preguntarle al servidor?
 *
 * EL AVISO NO TIENE AUTORIDAD. El canal es público: lo puede mandar cualquiera
 * con la clave pública de la aplicación. Por eso no dice QUÉ ha pasado —nadie
 * sube a nadie a un escenario mandándolo— y lo único que consigue es que se
 * pregunte: la respuesta sale siempre del servidor.
 *
 * Quien gestiona pregunta siempre (es su lista). El resto, solo si el aviso va
 * a su nombre o no dice para quién: con cien personas mirando, que las cien
 * pregunten cada vez que se invita a una sería un chaparrón para nada.
 */
export function meTocaElAviso(carga: unknown, miId: string | null, gestiono: boolean): boolean {
  if (miId === null) return false;
  if (gestiono) return true;
  if (!carga || typeof carga !== 'object') return true;
  const para = (carga as { para?: unknown }).para;
  if (para === null || para === undefined) return true;
  return para === miId;
}

/* ------------------------------------------------------------------------- *
 * CÓMO SE CUENTA UN FALLO
 * ------------------------------------------------------------------------- */

/** Código del servidor → clave del texto que lo explica. */
const TEXTO_DEL_FALLO: Record<string, string> = {
  live_guests_full: 'live.stageFull',
  live_guest_not_invited: 'live.stageInviteGone',
  live_guests_rate_limited: 'live.stageTooFast',
  live_guests_not_live: 'live.stageNotLive',
  live_guest_is_host: 'live.stageIsHost',
  live_guests_not_available: 'live.stageUnavailable',
};

/**
 * La clave de `i18n` que explica un fallo del escenario, o `null` si el código
 * no es de los suyos y hay que contarlo de la forma general.
 *
 * Devuelve la clave y no el texto para que este módulo siga sin importar nada.
 */
export function claveDelFalloDeEscenario(codigo: string | null | undefined): string | null {
  if (!codigo) return null;
  return Object.prototype.hasOwnProperty.call(TEXTO_DEL_FALLO, codigo)
    ? (TEXTO_DEL_FALLO[codigo] as string)
    : null;
}

/* ------------------------------------------------------------------------- *
 * QUÉ HACER CON LO QUE DICE EL SERVIDOR DE MÍ
 * ------------------------------------------------------------------------- */

export type PasoDeEscenario =
  /** Nada que hacer. */
  | 'nada'
  /** El servidor me da por arriba, pero yo no he subido EN ESTA VISITA. */
  | 'soltar_lo_viejo'
  /** Estaba arriba y el servidor ya no me tiene: me han quitado. */
  | 'bajar';

/**
 * Qué toca cuando llega una lectura nueva.
 *
 * `subidoAqui` es si esta persona pulsó «Aceptar» en ESTA visita a la sala.
 * Es lo que separa «estoy en pantalla» de «el servidor me recuerda de antes»:
 * quien aceptó, cerró la aplicación y vuelve sigue constando como aceptado, y
 * NO puede salir al aire solo por abrir la pantalla. Se le suelta esa plaza y
 * entra a mirar, como cualquiera.
 */
export function pasoTrasLeer(
  mio: EstadoDeInvitacion | null,
  { subidoAqui }: { subidoAqui: boolean },
): PasoDeEscenario {
  if (mio === 'accepted') return subidoAqui ? 'nada' : 'soltar_lo_viejo';
  return subidoAqui ? 'bajar' : 'nada';
}
