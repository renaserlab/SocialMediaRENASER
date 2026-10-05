/**
 * Cómo está HOY cada sesión 1:1 de la que habla una conversación.
 *
 * EL PROBLEMA. La solicitud de una sesión es un mensaje, y cada respuesta es
 * otro. Cada uno llega con el estado que tenía la sesión cuando se leyó: la
 * solicitud que se cargó hace diez minutos dice «pendiente» y la respuesta que
 * acaba de llegar dice «aceptada». Si la tarjeta de la solicitud pintara lo
 * que trae su propio mensaje, seguiría ofreciendo «Aceptar» con la respuesta
 * justo debajo. Es el mismo fallo que se reportó en la agenda, por otro camino.
 *
 * LA REGLA. De todo lo que se sabe de una sesión, manda LO MÁS RECIENTE SEGÚN
 * EL SERVIDOR (`actualizadaIso`, que es su `updated_at`). No el orden de
 * llegada ni el reloj del teléfono: una página vieja del historial puede
 * llegar después que la respuesta, y no por eso es más nueva.
 *
 * Lo que se sabe llega por dos caminos y los dos entran igual:
 *   - los mensajes de la conversación;
 *   - lo que devolvió el servidor al pulsar un botón, que se conoce antes de
 *     que llegue el mensaje que lo registra.
 *
 * SIN REACT: se prueba con el runner de Node.
 */

import type { MensajeDeSesion } from '@/types';

export type EstadoDeSesionEnChat = MensajeDeSesion['estado'];

/** Algo que se sabe de una sesión, venga de un mensaje o de una respuesta. */
export type LoSabidoDeUnaSesion = {
  sesionId: string;
  estado: EstadoDeSesionEnChat;
  actualizadaIso: string | null;
};

/**
 * El instante de una fecha del servidor, en milisegundos. 0 si no se entiende.
 *
 * PostgreSQL escribe microsegundos («…12.345678+00:00») y no todos los motores
 * de JavaScript los leen: se recortan a milisegundos antes de interpretar.
 */
function instante(iso: string | null | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * El estado vigente de cada sesión, por identificador.
 *
 * @param mensajes los de la conversación, en cualquier orden.
 * @param sabidas lo que se sabe por otra vía (la respuesta a un botón).
 */
export function estadosVigentes(
  mensajes: readonly { sesion?: MensajeDeSesion }[],
  sabidas: readonly LoSabidoDeUnaSesion[] = [],
): Map<string, EstadoDeSesionEnChat> {
  const mejor = new Map<string, { estado: EstadoDeSesionEnChat; cuando: number }>();
  const anotar = (dato: LoSabidoDeUnaSesion) => {
    const cuando = instante(dato.actualizadaIso);
    const previo = mejor.get(dato.sesionId);
    // `>=`: a igual instante gana lo último que se mira. Dos lecturas de la
    // misma versión de la sesión dicen lo mismo, así que no cambia nada; y lo
    // sabido por un botón, que se mira al final, no pierde un empate.
    if (!previo || cuando >= previo.cuando) {
      mejor.set(dato.sesionId, { estado: dato.estado, cuando });
    }
  };
  for (const mensaje of mensajes) {
    if (mensaje.sesion) anotar(mensaje.sesion);
  }
  for (const dato of sabidas) anotar(dato);

  const salida = new Map<string, EstadoDeSesionEnChat>();
  for (const [id, { estado }] of mejor) salida.set(id, estado);
  return salida;
}

/**
 * Lo sabido que YA NO HACE FALTA recordar: un mensaje de la conversación trae
 * esa versión de la sesión, o una más nueva. Sin esto la lista de lo sabido
 * crecería con cada botón pulsado mientras la pantalla siga abierta.
 */
export function loQueSigueHaciendoFalta(
  mensajes: readonly { sesion?: MensajeDeSesion }[],
  sabidas: readonly LoSabidoDeUnaSesion[],
): LoSabidoDeUnaSesion[] {
  const visto = new Map<string, number>();
  for (const mensaje of mensajes) {
    if (!mensaje.sesion) continue;
    const cuando = instante(mensaje.sesion.actualizadaIso);
    if (cuando > (visto.get(mensaje.sesion.sesionId) ?? -1)) {
      visto.set(mensaje.sesion.sesionId, cuando);
    }
  }
  return sabidas.filter(
    (dato) => instante(dato.actualizadaIso) > (visto.get(dato.sesionId) ?? -1),
  );
}

/**
 * Cómo se cuenta cada hecho en la conversación. Son CLAVES de traducción.
 *
 * Hay dos por hecho porque no se dice igual «Aceptaste la sesión» que «Ana
 * aceptó la sesión», y construir la frase a trozos no sobrevive a un segundo
 * idioma.
 */
const FRASES = {
  requested: ['chat.sessionYouRequested', 'chat.sessionTheyRequested'],
  accepted: ['chat.sessionYouAccepted', 'chat.sessionTheyAccepted'],
  rejected: ['chat.sessionYouRejected', 'chat.sessionTheyRejected'],
  cancelled: ['chat.sessionYouCancelled', 'chat.sessionTheyCancelled'],
  completed: ['chat.sessionYouCompleted', 'chat.sessionTheyCompleted'],
  reschedule_requested: ['chat.sessionYouRescheduled', 'chat.sessionTheyRescheduled'],
} as const;

export type ClaveDeHecho = (typeof FRASES)[keyof typeof FRASES][number];

/** @param mio si el mensaje lo firma quien está mirando. */
export function fraseDelHecho(hecho: MensajeDeSesion['hecho'], mio: boolean): ClaveDeHecho {
  const par = FRASES[hecho] ?? FRASES.requested;
  return mio ? par[0] : par[1];
}

/** El icono de cada hecho (nombres de Feather). */
export function iconoDelHecho(
  hecho: MensajeDeSesion['hecho'],
): 'calendar' | 'check-circle' | 'x-circle' | 'slash' | 'award' | 'clock' {
  switch (hecho) {
    case 'accepted':
      return 'check-circle';
    case 'rejected':
      return 'x-circle';
    case 'cancelled':
      return 'slash';
    case 'completed':
      return 'award';
    case 'reschedule_requested':
      return 'clock';
    default:
      return 'calendar';
  }
}
