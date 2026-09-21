import type { ClaveDeTraduccion } from '@/lib/productos';

/*
  POR EL ALIAS, como `envios.ts` y `pedidos.ts`, y por lo mismo: este módulo
  importa el TIPO de las claves de traducción. El ejecutor de pruebas de Node
  registra su propio resolutor para cargarlo; es maquinaria de la prueba.
*/

/**
 * El expediente de algo que llegó mal. LÓGICA PURA: sin React, sin red.
 *
 * LO QUE ESTA CAPA TIENE PROHIBIDO DECIR, y es la mitad de su trabajo:
 *
 *   * QUE ABRIR UN CASO SEA APROBARLO. Abrirlo solo anota que alguien dice que
 *     algo llegó mal. Los textos no pueden sugerir que ya se le dio la razón.
 *   * QUE RESOLVERLO SEA HABER PAGADO. Una resolución dice QUÉ se decidió. El
 *     dinero es del Incremento 9 y NO EXISTE: no hay reembolsos, ni
 *     transferencias, ni un solo importe en todo este módulo.
 *   * NINGUNA FECHA LÍMITE DE LA DECISIÓN DE Z. El blueprint habla de «tres
 *     días hábiles», y «hábil» depende de un calendario de festivos que nadie
 *     ha definido. Un caso en manos de Z se enseña «en revisión» y punto.
 *   * NINGÚN «SE TE VA A DEVOLVER». Ni siquiera con la resolución delante: lo
 *     que hay es una decisión registrada y un efecto PENDIENTE.
 *   * NINGÚN PORCENTAJE DE CASOS GANADOS, ninguna valoración, ningún histórico
 *     de disputas de nadie. No hay datos y no puede haberlos.
 *
 * Y NADA SE DECIDE AQUÍ. Qué salto es legal y quién puede darlo lo dice el
 * servidor con la fila bloqueada delante; esto pinta lo que el servidor ya
 * contestó y ofrece los botones que su `available_transitions` ofrece.
 */

/* -------------------------------------------------------------------------- */
/* El contrato                                                                 */
/* -------------------------------------------------------------------------- */

export type PruebaDelCaso = {
  id: string;
  /** `buyer`, `seller` o `admin`: quién la colgó. */
  uploaded_role: string;
  content_type: string;
  byte_size: number;
  width: number;
  height: number;
  caption: string | null;
  /** FIRMADA AL PINTAR. `null` = el almacenamiento no contestó. */
  url: string | null;
  created_at: string;
};

export type PasoDelCaso = {
  from_status: string | null;
  to_status: string;
  actor_role: string;
  note: string | null;
  created_at: string;
};

/**
 * El expediente entero. NO LLEVA NI UN IMPORTE, y es deliberado.
 *
 * Ni cuánto se devuelve, ni cuánto se pagó, ni ninguna referencia de pasarela:
 * una resolución de esta versión dice QUÉ se decidió, no CUÁNTO.
 */
export type Incidencia = {
  id: string;
  order_id: string;
  order_item_id: string | null;
  reason: string;
  description: string;
  status: string;
  /** LAS 48 HORAS DEL PROVEEDOR. `null` = la pelota no es suya ahora mismo. */
  seller_response_due_at: string | null;
  seller_responded_at: string | null;
  /** LO QUE PROPUSO, que no es lo que se decidió. */
  seller_proposal: string | null;
  resolution: string | null;
  resolved_at: string | null;
  /** `PENDING` o `NOT_APPLICABLE`. NUNCA «hecho»: nadie lo ejecuta. */
  financial_effect: string | null;
  appeal_due_at: string | null;
  appealed_at: string | null;
  appeals_used: number;
  withdrawn_at: string | null;
  evidence: PruebaDelCaso[];
  history: PasoDelCaso[];
  /** Lo que ESTE actor puede hacer ahora, según el servidor. */
  available_transitions: string[];
  created_at: string;
};

/** Una fila de una lista. SIN LA DESCRIPCIÓN NI EL HISTORIAL. */
export type ResumenDeIncidencia = {
  id: string;
  order_id: string;
  order_item_id: string | null;
  reason: string;
  status: string;
  seller_response_due_at: string | null;
  resolution: string | null;
  created_at: string;
};

/* -------------------------------------------------------------------------- */
/* Los motivos                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Los ocho motivos que el servidor acepta, y ninguno más.
 *
 * Tiene que coincidir con `products/estados_de_incidencia.py`. Siete son del
 * blueprint §10; `DELIVERY_DISPUTED` es el de «dice que no le llegó», que es un
 * caso del pedido entero y no de una línea.
 */
export const MOTIVOS = [
  'DAMAGED',
  'NOT_AS_DESCRIBED',
  'WRONG_ITEM',
  'MISSING_PARTS',
  'NOT_WORKING',
  'SUSPECTED_COUNTERFEIT',
  'OTHER',
  'DELIVERY_DISPUTED',
] as const;
export type MotivoDeIncidencia = (typeof MOTIVOS)[number];

/** El que habla del pedido entero: no llegó nada, así que no hay línea. */
export const ENTREGA_NEGADA = 'DELIVERY_DISPUTED';

/** Los que sí hablan de un artículo concreto. */
export const MOTIVOS_DEL_PRODUCTO: readonly string[] = MOTIVOS.filter(
  (m) => m !== ENTREGA_NEGADA,
);

export function esMotivoConocido(motivo: string): motivo is MotivoDeIncidencia {
  return (MOTIVOS as readonly string[]).includes(motivo);
}

export function claveDelMotivo(motivo: string): ClaveDeTraduccion {
  return esMotivoConocido(motivo)
    ? `incidencia.motivo.${motivo}`
    : 'incidencia.motivo.desconocido';
}

/** Si ese motivo necesita elegir una línea del pedido. */
export function pideLinea(motivo: string): boolean {
  return motivo !== ENTREGA_NEGADA;
}

/* -------------------------------------------------------------------------- */
/* Las fotografías y el texto                                                  */
/* -------------------------------------------------------------------------- */

/** Del blueprint §10, exactas: dos como mínimo y seis como máximo. */
export const FOTOS_MINIMAS = 2;
export const FOTOS_MAXIMAS = 6;

/** Del blueprint §10: «no funciona» a secas no deja saber qué mirar. */
export const DESCRIPCION_MINIMA = 20;
export const DESCRIPCION_MAXIMA = 2000;

/**
 * Cuántas fotografías exige ese motivo.
 *
 * LA ENTREGA NEGADA NO PUEDE PEDIR NINGUNA, y no es una excepción cómoda: a
 * quien dice que no le llegó nada no se le puede pedir la foto de lo que no
 * tiene. Exigírselas cerraría el único caso que solo él puede abrir.
 */
export function fotosExigidas(motivo: string): number {
  return motivo === ENTREGA_NEGADA ? 0 : FOTOS_MINIMAS;
}

/** Si ya se puede enviar el caso al proveedor. */
export function sePuedeEnviar(caso: Incidencia | null): boolean {
  if (caso === null) return false;
  if (caso.status !== 'OPEN') return false;
  return caso.evidence.length >= fotosExigidas(caso.reason);
}

/** Cuántas fotografías faltan todavía. Cero cuando ya se puede enviar. */
export function fotosQueFaltan(caso: Incidencia | null): number {
  if (caso === null) return 0;
  return Math.max(0, fotosExigidas(caso.reason) - caso.evidence.length);
}

/** Si ya no caben más. El servidor lo vuelve a comprobar. */
export function cabenMasFotos(caso: Incidencia | null): boolean {
  return caso !== null && caso.evidence.length < FOTOS_MAXIMAS;
}

/**
 * Por qué NO se puede adjuntar este archivo, o `null` si se puede.
 *
 * ES UNA COMPROBACIÓN DE CORTESÍA para no gastar una subida entera en algo que
 * va a fallar. La de verdad la hace el servidor, que abre la imagen: renombrar
 * un `.exe` a `.jpg` pasa por aquí y lo para él.
 *
 * NO REUTILIZA LA DEL CATÁLOGO aunque se le parezca: aquella exige texto
 * alternativo —una foto de catálogo sin describir es inaccesible— y corta en
 * cinco fotografías. Un expediente no lleva texto alternativo y admite seis.
 * Encajar los dos casos en una función habría sido pedir un dato que aquí nadie
 * escribe.
 *
 * LOS LÍMITES SON LOS DEL DEPÓSITO: los mismos diez megas y los mismos tres
 * tipos que declara la 0080.
 */
export type MotivoDelRechazo = 'tipo' | 'peso' | 'vacio' | 'demasiadas';

export function porQueNoSePuedeAdjuntar(opciones: {
  tipo: string | null | undefined;
  bytes: number | null | undefined;
  yaHay: number;
  maximoBytes: number;
  tiposAdmitidos: readonly string[];
}): MotivoDelRechazo | null {
  if (opciones.yaHay >= FOTOS_MAXIMAS) return 'demasiadas';
  //: `?? ''` porque con `noUncheckedIndexedAccess` el primer trozo de un
  //: `split` es `string | undefined`, aunque nunca lo sea de verdad.
  const tipo = ((opciones.tipo ?? '').split(';')[0] ?? '').trim().toLowerCase();
  if (!opciones.tiposAdmitidos.includes(tipo)) return 'tipo';
  if (typeof opciones.bytes !== 'number' || !Number.isFinite(opciones.bytes)) return null;
  if (opciones.bytes <= 0) return 'vacio';
  if (opciones.bytes > opciones.maximoBytes) return 'peso';
  return null;
}

/** La clave del texto de ese rechazo. Reutiliza las del catálogo: dicen lo mismo. */
export function claveDelRechazo(motivo: MotivoDelRechazo): ClaveDeTraduccion {
  return motivo === 'demasiadas'
    ? 'incidencia.error.demasiadasFotos'
    : (`fotos.noSePuede.${motivo}` as ClaveDeTraduccion);
}

/** Si la descripción tiene el largo que el servidor va a exigir. */
export function descripcionValida(texto: string): boolean {
  const limpio = texto.trim();
  return limpio.length >= DESCRIPCION_MINIMA && limpio.length <= DESCRIPCION_MAXIMA;
}

/* -------------------------------------------------------------------------- */
/* Los estados                                                                 */
/* -------------------------------------------------------------------------- */

/** Los siete estados que el servidor puede escribir, y ninguno más. */
export const ESTADOS_DE_INCIDENCIA = [
  'OPEN',
  'MORE_EVIDENCE_REQUESTED',
  'SELLER_RESPONDED',
  'MEDIATION',
  'RESOLVED',
  'APPEALED',
  'WITHDRAWN',
] as const;
export type EstadoDeIncidencia = (typeof ESTADOS_DE_INCIDENCIA)[number];

/** Los que todavía esperan a alguien. Un caso vivo bloquea lo incompatible. */
export const VIVAS: readonly string[] = [
  'OPEN',
  'MORE_EVIDENCE_REQUESTED',
  'SELLER_RESPONDED',
  'MEDIATION',
  'APPEALED',
];

export function esEstadoConocido(estado: string): estado is EstadoDeIncidencia {
  return (ESTADOS_DE_INCIDENCIA as readonly string[]).includes(estado);
}

/** Un estado sin nombre es peor que un nombre feo. */
export function claveDelEstadoDeIncidencia(estado: string): ClaveDeTraduccion {
  return esEstadoConocido(estado)
    ? `incidencia.estado.${estado}`
    : 'incidencia.estado.desconocido';
}

/**
 * El icono de un estado. `null` cuando no conocemos el código.
 *
 * EL COLOR NUNCA ES EL ÚNICO PORTADOR: el icono acompaña siempre al texto.
 */
export function iconoDelEstadoDeIncidencia(estado: string): string | null {
  const iconos: Record<string, string> = {
    OPEN: 'alert-circle',
    MORE_EVIDENCE_REQUESTED: 'camera',
    SELLER_RESPONDED: 'message-circle',
    MEDIATION: 'shield',
    RESOLVED: 'check-circle',
    APPEALED: 'rotate-ccw',
    WITHDRAWN: 'x-circle',
  };
  return iconos[estado] ?? null;
}

/** Si el caso sigue esperando a alguien. */
export function sigueVivo(caso: { status: string } | null): boolean {
  return caso !== null && VIVAS.includes(caso.status);
}

/** El caso vivo de ese pedido, si lo hay. */
export function casoVivo(
  casos: readonly ResumenDeIncidencia[],
): ResumenDeIncidencia | null {
  return casos.find((c) => VIVAS.includes(c.status)) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Las salidas                                                                 */
/* -------------------------------------------------------------------------- */

/** Las cinco del blueprint. PEDIR MÁS EVIDENCIA NO ES UNA: es un paso. */
export const RESOLUCIONES = [
  'RETURN_AND_FULL_REFUND',
  'FULL_REFUND_WITHOUT_RETURN',
  'PARTIAL_REFUND',
  'REPLACEMENT',
  'REJECT_CLAIM',
] as const;
export type Resolucion = (typeof RESOLUCIONES)[number];

export const PEDIR_MAS_EVIDENCIA = 'REQUEST_MORE_EVIDENCE';

/** Lo que el proveedor puede PROPONER. Proponer no es resolver. */
export const PROPUESTAS: readonly string[] = [...RESOLUCIONES, PEDIR_MAS_EVIDENCIA];

export function claveDeLaResolucion(resolucion: string): ClaveDeTraduccion {
  return (RESOLUCIONES as readonly string[]).includes(resolucion) ||
    resolucion === PEDIR_MAS_EVIDENCIA
    ? `incidencia.resolucion.${resolucion}`
    : 'incidencia.resolucion.desconocida';
}

/**
 * NO HAY NINGÚN IMPORTE EN ESTE MÓDULO, Y NO PUEDE HABERLO.
 *
 * Cuánto se devuelve es una decisión que nadie ha tomado —total, parcial, con
 * o sin el porte de vuelta—, y quién ejecuta el pago es del Incremento 9, que
 * no existe. Un número aquí sería una cifra que alguien leería como una
 * promesa. Esta constante existe para que la decisión esté escrita en un solo
 * sitio y no repartida por las pantallas.
 */
export const HAY_IMPORTE_DE_REEMBOLSO = false;

/**
 * NO HAY FECHA LÍMITE DE LA DECISIÓN DE Z, Y NO PUEDE HABERLA.
 *
 * El blueprint dice «tres días hábiles», y «hábil» depende de un calendario de
 * festivos que nadie ha definido. Lo honesto es «en revisión».
 */
export const HAY_PLAZO_DE_DECISION = false;

/**
 * Si el caso deja algo debiendo. LO DICE EL SERVIDOR, aquí solo se lee.
 *
 * NO SIGNIFICA QUE SE VAYA A PAGAR NI CUÁNDO: significa que esa decisión
 * todavía no se ha ejecutado. Quien lo ejecute es del Incremento 9.
 */
export function quedaAlgoPendiente(caso: Incidencia | null): boolean {
  return caso !== null && caso.financial_effect === 'PENDING';
}

/* -------------------------------------------------------------------------- */
/* Lo que puede hacer cada quien                                               */
/* -------------------------------------------------------------------------- */

/**
 * Si el servidor ofrece ese salto a quien pregunta.
 *
 * LA LISTA MANDA. Si el servidor no lo ofrece, aquí no se pinta, aunque el
 * estado lo permitiera sobre el papel: una versión vieja en un teléfono no
 * puede abrirse puertas que el servidor cerró.
 */
export function ofrece(caso: Incidencia | null, salto: string): boolean {
  return caso !== null && caso.available_transitions.includes(salto);
}

/** Si quien compró puede aportar la evidencia que le pidieron. */
export function sePuedeAportarEvidencia(caso: Incidencia | null): boolean {
  return caso !== null && caso.status === 'MORE_EVIDENCE_REQUESTED';
}

/**
 * Si se puede ofrecer apelar. UNA SOLA VEZ Y DENTRO DEL PLAZO.
 *
 * Las dos condiciones las vuelve a comprobar el servidor, y además exige
 * evidencia NUEVA —posterior a la resolución—, que esta capa no puede saber.
 * Ofrecerlo aquí no promete que vaya a salir bien; no ofrecerlo cuando el
 * servidor no lo ofrece sí evita prometer algo que ya no se puede.
 */
export function sePuedeApelar(caso: Incidencia | null): boolean {
  if (caso === null) return false;
  if (caso.appeals_used > 0) return false;
  return ofrece(caso, 'APPEALED');
}

/** Si quien lo abrió puede retirarlo. Solo antes de que se resuelva. */
export function sePuedeRetirar(caso: Incidencia | null): boolean {
  return ofrece(caso, 'WITHDRAWN');
}

/** Si se puede pedir que lo mire Z. */
export function sePuedeEscalar(caso: Incidencia | null): boolean {
  return ofrece(caso, 'MEDIATION');
}

/* -------------------------------------------------------------------------- */
/* El plazo del proveedor, dicho como un hecho                                 */
/* -------------------------------------------------------------------------- */

/** Las 48 horas del blueprint §10.1, transcritas. */
export const HORAS_PARA_RESPONDER = 48;

/** Las 48 horas de la apelación, del mismo sitio. */
export const HORAS_PARA_APELAR = 48;

/**
 * Cuánto le queda al proveedor. `null` cuando su reloj no corre.
 *
 * EL RELOJ CORRE SOLO MIENTRAS LA PELOTA ES SUYA: si pidió más evidencia, el
 * servidor manda `seller_response_due_at` nulo, y eso NO es «sin plazo», es
 * «ahora no le toca a él». Devolver cero aquí lo pintaría como vencido.
 */
export function horasQueLeQuedan(
  vence: string | null,
  ahora: number = Date.now(),
): number | null {
  if (vence === null) return null;
  const limite = Date.parse(vence);
  if (Number.isNaN(limite)) return null;
  return Math.ceil((limite - ahora) / 3_600_000);
}

/** Si ya se le pasó el plazo. El barrido del servidor es quien lo escala. */
export function sePasoDelPlazo(
  vence: string | null,
  ahora: number = Date.now(),
): boolean {
  const quedan = horasQueLeQuedan(vence, ahora);
  return quedan !== null && quedan <= 0;
}

/**
 * Cómo se dice lo que queda de plazo.
 *
 * NUNCA «INCUMPLIÓ». Pasado el plazo lo que ocurre es que el caso se manda a
 * mediación; decir que alguien incumplió algo es una acusación, y lo que hay
 * es un hecho: que el tiempo pasó.
 */
export function claveDelPlazo(vence: string | null, ahora: number = Date.now()) {
  const quedan = horasQueLeQuedan(vence, ahora);
  if (quedan === null) return 'incidencia.plazo.noCorre' as ClaveDeTraduccion;
  if (quedan <= 0) return 'incidencia.plazo.cumplido' as ClaveDeTraduccion;
  return 'incidencia.plazo.quedan' as ClaveDeTraduccion;
}

/* -------------------------------------------------------------------------- */
/* La línea de tiempo                                                          */
/* -------------------------------------------------------------------------- */

export type PasoPintable = {
  clave: ClaveDeTraduccion;
  icono: string | null;
  fecha: string;
  actor: string;
  nota: string | null;
};

/**
 * El historial del caso, listo para pintar.
 *
 * AQUÍ SÍ VA EL TEXTO LIBRE, y es la excepción: este expediente lo leen quien
 * reclama, quien responde y quien resuelve, que son las tres personas que ya
 * conocen el caso. Lo que NO puede pasar es que ese texto salga a una lista.
 *
 * ORDEN ESTABLE: dos pasos del mismo instante no pueden bailar entre renders.
 */
export function historialPintable(pasos: readonly PasoDelCaso[]): PasoPintable[] {
  return pasos
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const ta = Date.parse(a.p.created_at);
      const tb = Date.parse(b.p.created_at);
      if (Number.isNaN(ta) || Number.isNaN(tb) || ta === tb) return a.i - b.i;
      return ta - tb;
    })
    .map(({ p }) => ({
      clave: claveDelEstadoDeIncidencia(p.to_status),
      icono: iconoDelEstadoDeIncidencia(p.to_status),
      fecha: p.created_at,
      actor: p.actor_role,
      nota: p.note,
    }));
}

/* -------------------------------------------------------------------------- */
/* Los errores                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Cada código del servidor con su texto. AL MARGEN Y NO DENTRO DE LA FUNCIÓN,
 * igual que en `envios.ts`: hay una prueba que lee ESTE fichero y comprueba que
 * ningún código de incidencias llegue a una pantalla sin nada detrás, y para
 * poder leerlo la tabla tiene que estar donde se puede leer.
 */
const ERRORES: Record<string, ClaveDeTraduccion> = {
  product_incidents_not_available: 'incidencia.error.noDisponible',
  product_incident_not_found: 'incidencia.error.noEncontrado',
  product_incident_not_deliverable: 'incidencia.error.nadaQueReclamar',
  product_incident_already_open: 'incidencia.error.yaHayUno',
  product_incident_report_window_closed: 'incidencia.error.plazoCerrado',
  product_incident_reason_invalid: 'incidencia.error.motivoInvalido',
  product_incident_description_invalid: 'incidencia.error.descripcionCorta',
  product_incident_item_required: 'incidencia.error.faltaLinea',
  product_incident_item_not_in_order: 'incidencia.error.lineaAjena',
  product_incident_evidence_required: 'incidencia.error.faltanFotos',
  product_incident_evidence_too_many: 'incidencia.error.demasiadasFotos',
  product_incident_evidence_duplicated: 'incidencia.error.fotoRepetida',
  product_incident_not_your_turn: 'incidencia.error.noLeToca',
  product_incident_appeal_late: 'incidencia.error.apelacionTarde',
  product_incident_appeal_used: 'incidencia.error.apelacionAgotada',
  product_incident_appeal_without_evidence: 'incidencia.error.apelacionSinPruebas',
  product_incident_mediate_forbidden: 'incidencia.error.resolverProhibido',
  product_incident_resolution_invalid: 'incidencia.error.resolucionInvalida',
  product_incident_transition_invalid: 'incidencia.error.saltoInvalido',
  product_incident_transition_forbidden: 'incidencia.error.saltoProhibido',
  product_incident_reason_required: 'incidencia.error.faltaNota',
};

/** La clave del texto de un fallo del expediente, o `null` si no es de aquí. */
export function claveDeErrorDeIncidencias(
  codigo: string | null | undefined,
): ClaveDeTraduccion | null {
  const limpio = (codigo ?? '').trim();
  return limpio === '' ? null : (ERRORES[limpio] ?? null);
}

/** Si el fallo es que la 0080 no está aplicada en esa base. */
export function esIncidenciaApagada(codigo: string | null | undefined): boolean {
  return (codigo ?? '').trim() === 'product_incidents_not_available';
}
