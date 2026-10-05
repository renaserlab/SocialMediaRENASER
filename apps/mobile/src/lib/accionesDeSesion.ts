/**
 * Qué se puede hacer con una sesión 1:1, y dónde se enseña.
 *
 * LO REPORTADO (04/10/2026). «Cuando se acepta, el botón de aceptar sigue
 * estando ahí. Cuando se vuelve a poner aceptar aparece un mensaje diciendo
 * que ya no se puede realizar esta acción. Lo ideal es que una vez ponga
 * aceptar ya no siga apareciendo ese botón».
 *
 * LA CAUSA. La agenda decidía los botones por LA PESTAÑA en la que pintaba la
 * sesión, no por su estado: todo lo de «Solicitudes» llevaba Aceptar y
 * Rechazar, y una sesión que me pidieron seguía en «Solicitudes» después de
 * aceptarla porque el filtro era «sigue viva», no «espera mi respuesta». De
 * paso, una sesión que acepté no llegaba nunca a mi calendario, así que
 * tampoco podía cancelarla ni darla por hecha.
 *
 * AHORA HAY UNA TABLA, la misma del servidor (`bookings/schemas.py`,
 * `TRANSICIONES`): de cada estado y cada papel, qué se puede hacer. La leen
 * la agenda y la tarjeta del chat, así que las dos ofrecen lo mismo. Una
 * prueba compara esta tabla con la del servidor: un botón que el servidor va
 * a rechazar no llega a pintarse.
 *
 * REPROGRAMAR no está: el servidor lo admite, pero no hay pantalla para
 * proponer otra fecha. Un botón sin pantalla detrás sería un botón muerto.
 *
 * SIN REACT: se prueba con el runner de Node.
 */

export type EstadoDeLaSesion =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'cancelled'
  | 'reschedule_requested'
  | 'completed'
  | 'expired';

/** 'provider' = me la piden a mí; 'requester' = la pedí yo. */
export type PapelEnLaSesion = 'provider' | 'requester';

/** Lo que se puede pedir al servidor. Son estados a los que pasar. */
export type AccionDeSesion = 'accepted' | 'rejected' | 'cancelled' | 'completed';

const NADA: Record<PapelEnLaSesion, readonly AccionDeSesion[]> = { provider: [], requester: [] };

/**
 * De cada estado, qué puede hacer cada parte. EN EL ORDEN EN QUE SE PINTA: la
 * primera es la acción principal.
 */
const TABLA: Record<EstadoDeLaSesion, Record<PapelEnLaSesion, readonly AccionDeSesion[]>> = {
  // Quien la recibe responde; quien la pidió solo puede retirarla.
  pending: { provider: ['accepted', 'rejected'], requester: ['cancelled'] },
  // Hay otra fecha sobre la mesa: cualquiera de los dos puede darla por buena.
  reschedule_requested: {
    provider: ['accepted', 'rejected'],
    requester: ['accepted', 'cancelled'],
  },
  // Ya está acordada. NADIE vuelve a aceptarla: se hace o se cancela.
  accepted: { provider: ['completed', 'cancelled'], requester: ['completed', 'cancelled'] },
  // Finales: de aquí no se sale. Se pide otra.
  rejected: NADA,
  cancelled: NADA,
  completed: NADA,
  expired: NADA,
};

/** Los botones que le tocan a quien mira. Vacío = no hay nada que hacer. */
export function accionesDeSesion(
  estado: EstadoDeLaSesion,
  papel: PapelEnLaSesion,
): readonly AccionDeSesion[] {
  return TABLA[estado]?.[papel] ?? [];
}

/** Si la sesión admite todavía algún cambio, sea de quien sea. */
export function sigueViva(estado: EstadoDeLaSesion): boolean {
  const fila = TABLA[estado];
  return !!fila && (fila.provider.length > 0 || fila.requester.length > 0);
}

/**
 * Si la pelota está en mi tejado: alguien me ha pedido algo y no he
 * respondido. Es lo ÚNICO que cuenta como «solicitud».
 */
export function esperaMiRespuesta(estado: EstadoDeLaSesion, papel: PapelEnLaSesion): boolean {
  return papel === 'provider' && (estado === 'pending' || estado === 'reschedule_requested');
}

export type SeccionDeAgenda = 'solicitudes' | 'proximas' | 'historial';

/**
 * En qué parte de la agenda va una sesión.
 *
 *   - SOLICITUDES: lo que espera mi respuesta.
 *   - PRÓXIMAS: lo que sigue vivo y no espera nada de mí ahora —lo que pedí yo
 *     y lo ya confirmado, lo pidiera quien lo pidiera—.
 *   - HISTORIAL: lo que ya terminó.
 */
export function seccionDeLaSesion(
  estado: EstadoDeLaSesion,
  papel: PapelEnLaSesion,
): SeccionDeAgenda {
  if (esperaMiRespuesta(estado, papel)) return 'solicitudes';
  return sigueViva(estado) ? 'proximas' : 'historial';
}

/**
 * Cuál de las acciones es la principal (el botón relleno). Las demás son
 * secundarias. `null` si no hay ninguna.
 */
export function accionPrincipal(
  estado: EstadoDeLaSesion,
  papel: PapelEnLaSesion,
): AccionDeSesion | null {
  const primera = accionesDeSesion(estado, papel)[0];
  // Cancelar nunca es la acción principal: no se invita a deshacer.
  return primera && primera !== 'cancelled' ? primera : null;
}

/**
 * El código con el que el servidor dice «eso ya no se puede». No es un fallo:
 * es que la sesión cambió por otro lado —la aceptaste en la agenda y la
 * tarjeta del chat era vieja, o respondió la otra persona—. Quien lo recibe
 * vuelve a leer la sesión en vez de enseñar un error.
 */
export const CODIGO_YA_NO_SE_PUEDE = 'booking_transition_not_allowed';
