/**
 * Las reseñas verificadas de evento, del lado de la interfaz.
 *
 * NO DECIDEN NADA. Quién puede opinar lo dice `can-review`; si la respuesta del
 * organizador está habilitada lo dice el servidor al intentarla; el sello de
 * asistencia viene en `asistencia_verificada`. Aquí solo se traduce a texto lo
 * que el servidor ya ha dicho y se decide qué tiene sentido pintar.
 *
 * `null` NO ES CERO. Un evento sin reseñas no tiene una puntuación de 0.0: no
 * tiene puntuación. Por eso `promedioLegible`, `porcentajeQueRecomienda` y
 * `valorDelEje` devuelven `null`, y la pantalla escribe que todavía no hay
 * valoraciones en vez de pintar cinco estrellas vacías o un «0 %» que se leería
 * como una opinión que nadie ha dado.
 *
 * LA GENERAL NO ES LA MEDIA DE LOS EJES. Son dos preguntas distintas —«¿entregó
 * lo que anunció?» frente a cinco aspectos sueltos— y promediarlas exigiría
 * decidir cuánto pesa cada eje, que no lo ha decidido nadie. En este fichero no
 * hay ninguna función que calcule `overall`.
 *
 * EL SELLO NO SE DEDUCE. `asistenciaVerificada` mira el campo del servidor con
 * `=== true`: un campo ausente NO es un sello, y no existe ningún otro («compra
 * verificada» y demás) que esta capa pueda inventarse.
 *
 * Sin importaciones entre ficheros en tiempo de ejecución: el ejecutor de
 * pruebas de Node no resuelve el alias `@/`.
 */

/** Una clave del diccionario. La convierte la pantalla al traducir. */
export type ClaveDeTraduccion = string;

/** Los cinco ejes del contrato (`resenas.py`: `EJES`). */
export const EJES = ['content', 'organization', 'venue', 'safety', 'value'] as const;
export type Eje = (typeof EJES)[number];

/** De la mejor a la peor: el orden en el que se lee el histograma. */
export const PUNTUACIONES = [5, 4, 3, 2, 1] as const;

/** De la peor a la mejor: el orden en el que se dibuja una fila de estrellas. */
export const ESTRELLAS = [1, 2, 3, 4, 5] as const;

/** Los códigos que puede contestar `can-review`. `ok` es el del sí. */
export const MOTIVOS_PARA_RESENAR = [
  'ok',
  'policy_not_configured',
  'no_check_in',
  'own_event',
  'event_not_finished',
  'already_reviewed',
  'reviews_not_available',
  'event_not_found',
] as const;
export type MotivoParaResenar = (typeof MOTIVOS_PARA_RESENAR)[number];

/** Los estados que puede traer la reseña PROPIA. La pública no los trae. */
export const ESTADOS_DE_RESENA = ['visible', 'hidden', 'draft'] as const;

/** Lo más largo que el servidor acepta como comentario (`max_length=1000`). */
export const LARGO_MAXIMO_DEL_COMENTARIO = 1000;

/** Lo más largo que acepta una respuesta del organizador. */
export const LARGO_MAXIMO_DE_LA_RESPUESTA = 1000;

/** Cuántas reseñas se piden de una vez. El servidor admite hasta 100. */
export const POR_PAGINA = 20;

/** Lo que contesta `can-review`. */
export type PuedeResenar = {
  puede: boolean;
  /** CÓDIGO, no frase: la aplicación lo traduce. */
  motivo: string;
};

/** Lo que contesta `reviews/summary`. Todo lo ausente es ausente, no cero. */
export type ResumenDeResenas = {
  total: number;
  /** `null` cuando no hay reseñas. NUNCA 0. */
  promedio: number | null;
  /** `{ "1": n, … "5": n }`. Los cajones sin nadie pueden no venir. */
  histograma?: Record<string, number> | null;
  /** En puntos básicos. `null` = nadie contestó a la pregunta. */
  recomiendan_bps: number | null;
  /** Por aspecto. Cada uno puede ser `null` por separado. */
  por_eje?: Partial<Record<string, number | null>> | null;
};

/** Lo mínimo de una reseña para lo que decide este fichero. */
export type ResenaMinima = {
  id: string;
  created_at: string;
  asistencia_verificada?: boolean;
  respuesta?: { id: string } | null;
  status?: string | null;
};

function entero(valor: unknown): number {
  return typeof valor === 'number' && Number.isFinite(valor) && valor > 0
    ? Math.trunc(valor)
    : 0;
}

function conocido(valores: readonly string[], valor: string, prefijo: string): string {
  return valores.includes(valor) ? `${prefijo}.${valor}` : `${prefijo}.desconocido`;
}

/** La clave de traducción del nombre de un eje. */
export function claveDelEje(eje: string): ClaveDeTraduccion {
  return conocido(EJES, eje, 'resenas.eje');
}

/** La clave de traducción del código de `can-review`. */
export function claveDelMotivoParaResenar(motivo: string): ClaveDeTraduccion {
  return conocido(MOTIVOS_PARA_RESENAR, motivo, 'resenas.motivo');
}

/**
 * Si hay algo que resumir.
 *
 * Con `total` en cero no hay promedio, ni histograma, ni porcentaje: no es que
 * el evento esté mal valorado, es que todavía no lo ha valorado nadie.
 */
export function hayValoraciones(resumen: ResumenDeResenas | null | undefined): boolean {
  return entero(resumen?.total) > 0;
}

/**
 * El promedio con UN decimal, o `null`.
 *
 * `null` sin promedio y `null` sin reseñas, aunque el campo trajera un número:
 * una media sobre cero opiniones no es una media. Quien pinta escribe entonces
 * «todavía no hay valoraciones» y NO dibuja cinco estrellas vacías.
 */
export function promedioLegible(
  resumen: ResumenDeResenas | null | undefined,
): string | null {
  const media = resumen?.promedio;
  if (typeof media !== 'number' || !Number.isFinite(media)) return null;
  if (!hayValoraciones(resumen)) return null;
  return media.toFixed(1);
}

/**
 * Cuántos de cada nota, de la 5 a la 1.
 *
 * Los cajones que faltan valen 0, y eso NO es inventar: el servidor agrupa solo
 * las notas que existen, así que un cajón ausente significa que nadie ha puesto
 * esa nota. Sin ninguna reseña devuelve la lista vacía, para que la pantalla no
 * pinte cinco barras a cero.
 */
export function histogramaOrdenado(
  resumen: ResumenDeResenas | null | undefined,
): Array<{ puntuacion: number; cuantas: number; proporcion: number }> {
  if (!hayValoraciones(resumen)) return [];
  const total = entero(resumen?.total);
  return PUNTUACIONES.map((puntuacion) => {
    const cuantas = entero(resumen?.histograma?.[String(puntuacion)]);
    return { puntuacion, cuantas, proporcion: proporcionDeBarra(cuantas, total) };
  });
}

/** Cuánto ocupa una barra, de 0 a 1. Sin total, nada. */
export function proporcionDeBarra(cuantas: number, total: number): number {
  const c = entero(cuantas);
  const suma = entero(total);
  if (suma === 0 || c === 0) return 0;
  return Math.min(1, c / suma);
}

/** Lo mismo, en la unidad que entiende un estilo. */
export function anchoDeBarra(cuantas: number, total: number): `${number}%` {
  return `${Math.round(proporcionDeBarra(cuantas, total) * 100)}%`;
}

/**
 * Qué porcentaje recomienda, o `null`.
 *
 * `recomiendan_bps` es `null` cuando NADIE contestó a esa pregunta, y eso no es
 * «0 % lo recomienda»: es que no hay respuestas. La pantalla lo dice con su
 * propia frase y no escribe ninguna cifra.
 */
export function porcentajeQueRecomienda(bps: number | null | undefined): number | null {
  if (typeof bps !== 'number' || !Number.isFinite(bps)) return null;
  const seguro = Math.min(10_000, Math.max(0, bps));
  return Math.round(seguro / 100);
}

/** El mismo porcentaje ya escrito («87%»), o `null` si nadie contestó. */
export function porcentajeLegible(bps: number | null | undefined): string | null {
  const porcentaje = porcentajeQueRecomienda(bps);
  return porcentaje === null ? null : `${porcentaje}%`;
}

/**
 * La nota de un eje, o `null`.
 *
 * Cada eje es opcional por separado: quien solo contestó la pregunta general
 * deja los cinco vacíos, y ahí no hay ningún número que enseñar.
 */
export function valorDelEje(
  resumen: ResumenDeResenas | null | undefined,
  eje: string,
): number | null {
  const valor = resumen?.por_eje?.[eje];
  if (typeof valor !== 'number' || !Number.isFinite(valor)) return null;
  if (!hayValoraciones(resumen)) return null;
  return valor;
}

/** Los cinco ejes en orden, con su nota o con `null`. Ninguno se omite. */
export function ejesDelResumen(
  resumen: ResumenDeResenas | null | undefined,
): Array<{ eje: Eje; valor: number | null; texto: string | null }> {
  return EJES.map((eje) => {
    const valor = valorDelEje(resumen, eje);
    return { eje, valor, texto: valor === null ? null : valor.toFixed(1) };
  });
}

/** Si el servidor dice que esta persona puede escribir. `true` y nada más. */
export function puedeEscribir(permiso: PuedeResenar | null | undefined): boolean {
  return permiso?.puede === true;
}

/**
 * Por qué NO se puede escribir, o `null`.
 *
 * Devuelve una CLAVE, nunca el texto del servidor: sus mensajes están escritos
 * en español dentro del router, y pintarlos tal cual le enseña castellano a
 * quien tiene la aplicación en inglés.
 */
export function motivoParaNoResenar(
  permiso: PuedeResenar | null | undefined,
): ClaveDeTraduccion | null {
  if (permiso == null) return null;
  if (permiso.puede === true) return null;
  return claveDelMotivoParaResenar(permiso.motivo);
}

/**
 * Si el SERVIDOR dice que quien mira organiza este evento.
 *
 * `own_event` solo lo contesta `can-review` después de comprobar que el evento
 * existe y que `organizer_id` es esta persona. Es la única afirmación de ese
 * hecho que la aplicación tiene sin deducir nada por su cuenta.
 */
export function elServidorDiceQueOrganiza(
  permiso: PuedeResenar | null | undefined,
): boolean {
  return permiso?.puede === false && permiso?.motivo === 'own_event';
}

/**
 * El sello de asistencia verificada.
 *
 * `=== true` y no `?? true`: un campo ausente —un servidor anterior— NO es un
 * sello. Y no hay ningún otro: la aplicación no afirma «compra verificada» ni
 * nada parecido, porque no tiene con qué sostenerlo.
 */
export function asistenciaVerificada(resena: ResenaMinima | null | undefined): boolean {
  return resena?.asistencia_verificada === true;
}

/** Si ya hay respuesta del organizador debajo. Una como mucho. */
export function tieneRespuesta(resena: ResenaMinima | null | undefined): boolean {
  return resena?.respuesta != null;
}

/** Si moderación la escondió. Solo puede venir en la propia. */
export function estaEscondida(resena: ResenaMinima | null | undefined): boolean {
  return resena?.status === 'hidden';
}

/**
 * Si tiene sentido ofrecer la caja de responder.
 *
 * DOS CONDICIONES: que el servidor haya dicho que esta persona organiza el
 * evento y que la reseña no tenga ya respuesta. Que la función esté habilitada
 * lo decide la política, y eso solo se sabe al intentarlo: el servidor contesta
 * `event_reply_not_configured`, que tiene su propio texto.
 */
export function puedeOfrecerResponder(
  resena: ResenaMinima | null | undefined,
  organiza: boolean,
): boolean {
  return organiza === true && resena != null && !tieneRespuesta(resena);
}

/** Del 1 al 5, entero. Lo vuelve a comprobar el servidor. */
export function puntuacionValida(puntuacion: unknown): boolean {
  return (
    typeof puntuacion === 'number' &&
    Number.isInteger(puntuacion) &&
    puntuacion >= 1 &&
    puntuacion <= 5
  );
}

/** Cuántos caracteres lleva escritos, para el contador. Sin limpiar. */
export function largoDelComentario(texto: string | null | undefined): number {
  return (texto ?? '').length;
}

/**
 * El comentario que viaja. Cadena SIEMPRE, nunca `null`.
 *
 * Es a propósito: al editar, el servidor solo toca el comentario si el campo no
 * es `None`, así que mandar `null` para borrarlo lo dejaría intacto. La cadena
 * vacía sí lo borra, y al crear se guarda igual como «sin comentario».
 */
export function comentarioParaEnviar(texto: string | null | undefined): string {
  return (texto ?? '').trim().slice(0, LARGO_MAXIMO_DEL_COMENTARIO);
}

/**
 * Los ejes que viajan, o `null` si no se puntuó ninguno.
 *
 * Solo los valores del 1 al 5. Un eje sin puntuar no se manda con un cero: el
 * servidor lo guardaría como una nota de cero, que está fuera de su propio
 * rango y diría algo que nadie ha dicho.
 */
export function ejesParaEnviar(
  ejes: Partial<Record<string, number | null | undefined>> | null | undefined,
): Record<string, number> | null {
  const salida: Record<string, number> = {};
  for (const eje of EJES) {
    const valor = ejes?.[eje];
    if (puntuacionValida(valor)) salida[eje] = valor as number;
  }
  return Object.keys(salida).length === 0 ? null : salida;
}

/** Lo que la pantalla tiene en las manos antes de mandar nada. */
export type BorradorDeResena = {
  overall: number | null;
  ejes?: Partial<Record<string, number | null>> | null;
  recomienda?: boolean | null;
  comentario?: string | null;
};

/**
 * Por qué NO se puede enviar todavía, o `null`.
 *
 * Se comprueba aquí para no mandar una petición que el servidor va a rechazar
 * con un 422 sobre un texto que la persona ya había escrito.
 */
export function motivoParaNoEnviar(
  borrador: BorradorDeResena,
): ClaveDeTraduccion | null {
  if (!puntuacionValida(borrador.overall)) return 'resenas.eligePuntuacion';
  if (largoDelComentario(borrador.comentario) > LARGO_MAXIMO_DEL_COMENTARIO) {
    return 'resenas.comentarioLargo';
  }
  return null;
}

/** El cuerpo tal y como lo espera `CrearResenaRequest`. */
export type CuerpoDeResena = {
  overall: number;
  /** Solo los ejes puntuados. Los que faltan llegan al servidor como «sin
   * puntuar», que es lo que son. */
  ejes: Record<string, number>;
  recommends: boolean | null;
  comment: string;
};

/**
 * El cuerpo que se manda. Lanza si el borrador no es válido.
 *
 * No hay ningún `overall` calculado a partir de los ejes: la pregunta general
 * es otra pregunta, y la contesta la persona.
 *
 * `ejes` VIAJA SIEMPRE, aunque vaya vacío. Al editar, el servidor solo toca los
 * ejes cuando el campo llega, así que omitirlo al quitar la última nota dejaría
 * las cinco anteriores puestas: quien las borra las vería seguir ahí.
 */
export function cuerpoDeResena(borrador: BorradorDeResena): CuerpoDeResena {
  if (!puntuacionValida(borrador.overall)) {
    throw new Error('La puntuación general tiene que ser un entero del 1 al 5.');
  }
  return {
    overall: borrador.overall as number,
    ejes: ejesParaEnviar(borrador.ejes) ?? {},
    recommends: borrador.recomienda ?? null,
    comment: comentarioParaEnviar(borrador.comentario),
  };
}

/**
 * La respuesta del organizador que SÍ se puede mandar, o `null`.
 *
 * El servidor pide `min_length=1`, así que una caja con espacios no es una
 * respuesta: se avisa antes en vez de recoger un 422.
 */
export function respuestaParaEnviar(texto: string | null | undefined): string | null {
  const limpio = (texto ?? '').trim();
  if (limpio === '') return null;
  return limpio.slice(0, LARGO_MAXIMO_DE_LA_RESPUESTA);
}

/**
 * El cursor de la página siguiente, o `null` cuando no hay más.
 *
 * Formato del servidor: `created_at|id`. La `Z` final se escribe `+00:00`
 * —el mismo instante— porque `datetime.fromisoformat` no aceptó la `Z` hasta
 * Python 3.11 y un cursor que no parsea se contesta con un 400.
 *
 * UNA PÁGINA CORTA SIGNIFICA QUE SE ACABÓ. Una página llena no garantiza que
 * haya más, pero el servidor no dice cuántas quedan y la lectura segura es
 * ofrecer el botón: quedarse corto esconde reseñas que existen.
 */
export function cursorDeLaPagina(
  items: readonly ResenaMinima[],
  limite: number = POR_PAGINA,
): string | null {
  if (limite <= 0 || items.length < limite) return null;
  const ultimo = items[items.length - 1];
  if (!ultimo || !ultimo.created_at || !ultimo.id) return null;
  return `${ultimo.created_at.replace(/Z$/, '+00:00')}|${ultimo.id}`;
}

/** Si conviene ofrecer «ver más». */
export function hayMasPaginas(recibidas: number, limite: number = POR_PAGINA): boolean {
  return limite > 0 && recibidas >= limite;
}

/**
 * Une la página nueva con lo que ya había, SIN repetir.
 *
 * El cursor es estable, pero una recarga o una reseña nueva pueden traer algo
 * ya visto; repetida en la lista parecería que alguien opinó dos veces.
 */
export function fusionarPaginas<T extends { id: string }>(
  previas: readonly T[],
  nuevas: readonly T[],
): T[] {
  const vistas = new Set(previas.map((r) => r.id));
  return [...previas, ...nuevas.filter((r) => !vistas.has(r.id))];
}

/**
 * Si este código significa «las reseñas todavía no están encendidas».
 *
 * El servidor contesta 503 con `event_reviews_not_available` cuando la 0067 no
 * está aplicada. No es un error de nadie: es una parte del sistema que aún no
 * existe, y merece su propio texto.
 */
export function esResenasApagadas(codigo: string | null | undefined): boolean {
  return codigo === 'event_reviews_not_available';
}

/**
 * Si este código significa «responder públicamente no está habilitado».
 *
 * Tiene su propio texto y no el genérico: no es un fallo ni una negativa a esta
 * persona, es que la empresa todavía no ha publicado las reglas con las que se
 * responde en público.
 */
export function esRespuestaApagada(codigo: string | null | undefined): boolean {
  return codigo === 'event_reply_not_configured';
}

/**
 * Qué decirle a la persona cuando el servidor dice que no.
 *
 * POR CÓDIGO ESTABLE, NO POR TEXTO. `null` para un código que no se conoce:
 * entonces la pantalla usa el mensaje del servidor, que en español es correcto
 * y en otro idioma es mejor que nada.
 */
export function claveDeErrorDeResena(
  codigo: string | null | undefined,
): ClaveDeTraduccion | null {
  const conocidos: Record<string, string> = {
    event_reviews_not_available: 'resenas.error.noDisponible',
    event_review_not_allowed: 'resenas.error.noPermitida',
    event_review_already_exists: 'resenas.error.yaExiste',
    event_review_not_found: 'resenas.error.noEncontrada',
    event_review_changed: 'resenas.error.cambiada',
    event_review_cursor_invalid: 'resenas.error.cursorInvalido',
    event_reply_not_configured: 'resenas.error.respuestaNoConfigurada',
    event_reply_already_exists: 'resenas.error.respuestaYaExiste',
    // NO INVITAN A REINTENTAR. Un 403 no se arregla volviendo a pulsar y un 429
    // se arregla esperando.
    forbidden: 'resenas.error.sinPermiso',
    not_authorized: 'resenas.error.sinPermiso',
    rate_limited: 'errorDeEntradas.demasiadosIntentos',
    too_many_requests: 'errorDeEntradas.demasiadosIntentos',
  };
  if (typeof codigo !== 'string') return null;
  return conocidos[codigo] ?? null;
}

/**
 * El motivo por el que el servidor rechazó la reseña, traducido.
 *
 * `event_review_not_allowed` viaja con `details.reason`, que es uno de los
 * códigos de `can-review`: sin mirarlo, quien no hizo check-in y quien llega
 * tarde leen exactamente la misma frase.
 */
export function motivoDelRechazo(detalle: unknown): ClaveDeTraduccion | null {
  if (typeof detalle !== 'object' || detalle === null) return null;
  const razon = (detalle as { reason?: unknown }).reason;
  if (typeof razon !== 'string' || razon.trim() === '') return null;
  return claveDelMotivoParaResenar(razon);
}
