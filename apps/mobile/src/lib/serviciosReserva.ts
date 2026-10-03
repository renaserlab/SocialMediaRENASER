/**
 * Z Servicios, Incremento 5: la reserva. Lo que la app necesita saber de ella,
 * SIN DECIDIR NADA: si un horario está libre, cuánto queda para que venza una
 * retención, qué se acepta y si se puede contratar lo dice el servidor.
 *
 * TRES COSAS QUE AQUÍ NO SE HACEN, a propósito:
 *
 *   * CALCULAR EL VENCIMIENTO con el reloj del teléfono. La cuenta atrás parte
 *     de los segundos que dijo el servidor y solo resta lo que ha pasado desde
 *     que llegó la respuesta: un teléfono con la hora mal no cambia nada.
 *   * GUARDAR LA DIRECCIÓN O LA NOTA EN LA RUTA. Pasan de un paso al siguiente
 *     en la memoria de la app (`guardarBorrador`) y se olvidan al confirmar o
 *     al soltar. Una ruta puede acabar en el historial del navegador.
 *   * DAR POR RESERVADO lo que solo está ELEGIDO o APARTADO. Tres palabras
 *     distintas: elegido (solo en la pantalla), apartado (una retención que
 *     vence) y reservado (confirmado por el servidor).
 */
import type { Precio } from '@/lib/serviciosCatalogo';

export const ESTADOS_DE_LA_RETENCION = ['active', 'consumed', 'released', 'expired'] as const;
export type EstadoDeLaRetencion = (typeof ESTADOS_DE_LA_RETENCION)[number];

/** Cómo se contrata, según su precio (lo decide el servidor). */
export const FORMAS_DE_CONTRATAR = ['free', 'paid', 'quote_required', 'price_not_closed'] as const;

/** Lo que impide confirmar AHORA, en códigos del servidor (`contract.blockers`). */
export const BLOQUEOS = [
  'hold_expired',
  'hold_released',
  'hold_consumed',
  'version_changed',
  'payments_not_configured',
  'quote_required',
  'price_not_closed',
  'provider_confirmation_required',
  'terms_unavailable',
] as const;

/** Los del servidor, en su orden (`ACCIONES`). Del Incremento 6: cancelar, reprogramar, la atención, el caso y la reseña. */
export const SUCESOS_DE_LA_RESERVA = [
  'hold_created',
  'hold_released',
  'hold_expired',
  'booking_confirmed',
  'booking_cancelled',
  'booking_rescheduled',
  'booking_reminded',
  'attendance_code_issued',
  'attendance_started',
  'attendance_completed',
  'attendance_confirmed',
  'attendance_closed',
  'no_show_reported',
  'incident_opened',
  'incident_entry_added',
  'incident_withdrawn',
  'incident_resolved',
  'incident_appealed',
  'review_created',
  'review_replied',
  'review_moderated',
] as const;
export const AMBITOS_DE_RESERVAS = ['upcoming', 'past'] as const;
export type AmbitoDeReservas = (typeof AMBITOS_DE_RESERVAS)[number];

/** Los mismos largos que la 0093 y `reserva_politica.py` (una prueba los compara). */
export const LARGOS_DE_LA_CONTRATACION = { nota: 500, distrito: 100, direccion: 200, referencia: 200 } as const;

// --------------------------------------------------------------------------- //
// Lo que llega del servidor
// --------------------------------------------------------------------------- //
export type Retencion = {
  id: string;
  service_id: string;
  /** El que vale: una activa cuyo plazo pasó llega como `expired`. */
  status: string;
  starts_at: string;
  ends_at: string;
  date: string;
  time: string;
  end_time: string;
  utc_offset: string;
  timezone: string;
  modality: string;
  expires_at: string;
  server_now: string;
  seconds_left: number;
  booking_id: string | null;
};

export type Resumen = {
  hold: Retencion;
  service: {
    id: string;
    version_id: string;
    title: string | null;
    modality: string | null;
    duration_minutes: number | null;
    location_area: string | null;
    provider_name: string | null;
    price: Precio;
  };
  contract: {
    kind: string;
    confirmable: boolean;
    payments_available: boolean;
    provider_confirmation_required: boolean;
    version_changed: boolean;
    terms_available: boolean;
    blockers: string[];
  };
  terms: { policy_id: string; version: number; title: string; body: string; sha256: string } | null;
  service_conditions: { text: string; sha256: string } | null;
  requires_address: boolean;
  limits: {
    note_max_length: number;
    district_max_length: number;
    address_max_length: number;
    reference_max_length: number;
  };
};

export type Reserva = {
  id: string;
  code: string;
  status: string;
  service_id: string;
  title: string;
  provider_name: string;
  starts_at: string;
  ends_at: string;
  date: string;
  time: string;
  end_time: string;
  utc_offset: string;
  timezone: string;
  modality: string;
  duration_minutes: number;
  location_area: string | null;
  confirmed_at: string;
};

export type ReservaDetalle = Reserva & {
  price: { model: string; amount_minor: number | null; currency: string | null; total_minor: number; payment_status: string };
  intake: { note: string | null; district: string | null; address_line: string | null; address_reference: string | null } | null;
  acceptances: { kind: string; version: number | null; sha256: string; accepted_at: string }[];
  history: { action: string; status: string; at: string }[];
};

export type ReservaDelPrestador = ReservaDetalle & {
  /** La identidad PÚBLICA de quien contrata; `null` si su cuenta ya no existe. */
  client: { username: string | null; name: string | null } | null;
};

export type PaginaDeReservas = { items: Reserva[]; next_cursor: string | null };

export type RetencionAdmin = {
  id: string;
  service_id: string;
  client_id: string | null;
  status: string;
  starts_at: string;
  expires_at: string;
  created_at: string;
};
export type ReservaAdmin = {
  id: string;
  code: string;
  status: string;
  service_id: string;
  provider_id: string;
  client_id: string | null;
  title: string;
  starts_at: string;
  modality: string;
  confirmed_at: string;
};

// --------------------------------------------------------------------------- //
// Palabras
// --------------------------------------------------------------------------- //
function es<T extends string>(lista: readonly T[], valor: unknown): valor is T {
  return typeof valor === 'string' && (lista as readonly string[]).includes(valor);
}

export function claveDelEstadoDeLaRetencion(estado: string | null | undefined): string {
  return es(ESTADOS_DE_LA_RETENCION, estado)
    ? `servicios.reserva.retencion.${estado}`
    : 'servicios.reserva.retencion.desconocido';
}

export function claveDelBloqueo(bloqueo: string): string | null {
  return es(BLOQUEOS, bloqueo) ? `servicios.reserva.bloqueo.${bloqueo}` : null;
}

export function claveDelSuceso(accion: string): string {
  return es(SUCESOS_DE_LA_RESERVA, accion) ? `servicios.reserva.suceso.${accion}` : 'servicios.reserva.suceso.otro';
}

export function claveDeLaAceptacion(tipo: string): string {
  return tipo === 'service_conditions' ? 'servicios.reserva.aceptadas.servicio' : 'servicios.reserva.aceptadas.z';
}

// --------------------------------------------------------------------------- //
// La cuenta atrás, con la hora del SERVIDOR
// --------------------------------------------------------------------------- //
/**
 * Los segundos que le quedan a una retención: los que dijo el servidor menos
 * lo que ha pasado DESDE QUE LLEGÓ su respuesta (`recibidaEn`, en el reloj del
 * teléfono). La hora del teléfono no importa; solo cuánto tiempo ha pasado.
 */
export function segundosRestantes(
  retencion: Pick<Retencion, 'status' | 'seconds_left'>,
  recibidaEn: number,
  ahora: number,
): number {
  if (retencion.status !== 'active') return 0;
  const pasados = Math.max(0, Math.floor((ahora - recibidaEn) / 1000));
  return Math.max(0, Math.floor(retencion.seconds_left) - pasados);
}

/** «09:42». */
export function cuentaAtras(segundos: number): string {
  const s = Math.max(0, Math.floor(segundos));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// --------------------------------------------------------------------------- //
// El formulario de la contratación
// --------------------------------------------------------------------------- //
export type FormularioDeContratacion = {
  nota: string;
  distrito: string;
  direccion: string;
  referencia: string;
  /**
   * LO QUE SE ACEPTÓ, NO UN «SÍ»: la versión y la huella de las condiciones
   * de contratación de Z que estaban EN PANTALLA al marcar la casilla
   * (`huellaDeLoAceptable`). Si el servidor trae otras (la empresa publicó
   * una versión nueva mientras tanto), la casilla aparece SIN MARCAR y no se
   * manda nada: lo que se registra como aceptado es lo que la persona vio.
   */
  acepta: string | null;
  /** Lo mismo con las condiciones del servicio, si las tiene. */
  aceptaServicio: string | null;
};

export function formularioVacio(): FormularioDeContratacion {
  return { nota: '', distrito: '', direccion: '', referencia: '', acepta: null, aceptaServicio: null };
}

/** Las de Z o las del servicio. */
export type LoAceptable = 'z' | 'servicio';

/** Qué se está aceptando AHORA MISMO en ese resumen; `null` si no hay nada que aceptar. */
export function huellaDeLoAceptable(r: Pick<Resumen, 'terms' | 'service_conditions'>, que: LoAceptable): string | null {
  if (que === 'z') return r.terms === null ? null : `${r.terms.policy_id}:${r.terms.sha256}`;
  return r.service_conditions === null ? null : r.service_conditions.sha256;
}

/** Si la casilla está marcada para LO QUE HAY EN PANTALLA, no para algo leído antes. */
export function estaAceptado(
  r: Pick<Resumen, 'terms' | 'service_conditions'>,
  f: FormularioDeContratacion,
  que: LoAceptable,
): boolean {
  const huella = huellaDeLoAceptable(r, que);
  return huella !== null && (que === 'z' ? f.acepta : f.aceptaServicio) === huella;
}

/** Marcar o desmarcar la casilla: al marcar se guarda la huella de lo que se ve. */
export function alternarAceptacion(
  r: Pick<Resumen, 'terms' | 'service_conditions'>,
  f: FormularioDeContratacion,
  que: LoAceptable,
): FormularioDeContratacion {
  const valor = estaAceptado(r, f, que) ? null : huellaDeLoAceptable(r, que);
  return que === 'z' ? { ...f, acepta: valor } : { ...f, aceptaServicio: valor };
}

export type Resultado = { peticion: Record<string, unknown> | null; fallo: string | null };

/**
 * Lo que se manda al confirmar, o por qué todavía no. El SERVIDOR vuelve a
 * comprobarlo todo; esto solo avisa antes de lo evidente.
 *
 * Solo lo necesario: una nota opcional y, A DOMICILIO, el distrito y la
 * dirección. En otra modalidad no se manda ninguna dirección.
 */
export function peticionDeConfirmacion(r: Resumen, f: FormularioDeContratacion): Resultado {
  if (r.terms === null) return { peticion: null, fallo: 'servicios.reserva.error.sinCondiciones' };
  // Aceptó OTRA versión (o las del servicio cambiaron): se dice que algo
  // cambió y la casilla queda sin marcar; nunca se manda como aceptado lo
  // que la persona no vio.
  if (!estaAceptado(r, f, 'z')) {
    return { peticion: null, fallo: f.acepta === null ? 'servicios.reserva.error.aceptar' : 'servicios.reserva.algoCambio' };
  }
  if (r.service_conditions !== null && !estaAceptado(r, f, 'servicio')) {
    return {
      peticion: null,
      fallo: f.aceptaServicio === null ? 'servicios.reserva.error.aceptarServicio' : 'servicios.reserva.algoCambio',
    };
  }
  const nota = f.nota.trim();
  if (nota.length > r.limits.note_max_length) return { peticion: null, fallo: 'servicios.reserva.error.largo' };
  const peticion: Record<string, unknown> = {
    terms_policy_id: r.terms.policy_id,
    terms_sha256: r.terms.sha256,
    note: nota || null,
  };
  if (r.service_conditions !== null) peticion.service_conditions_sha256 = r.service_conditions.sha256;
  if (r.requires_address) {
    const distrito = f.distrito.trim();
    const direccion = f.direccion.trim();
    const referencia = f.referencia.trim();
    if (!distrito || !direccion) return { peticion: null, fallo: 'servicios.reserva.error.direccion' };
    if (
      distrito.length > r.limits.district_max_length ||
      direccion.length > r.limits.address_max_length ||
      referencia.length > r.limits.reference_max_length
    ) {
      return { peticion: null, fallo: 'servicios.reserva.error.largo' };
    }
    peticion.district = distrito;
    peticion.address_line = direccion;
    peticion.address_reference = referencia || null;
  }
  return { peticion, fallo: null };
}

/**
 * EL BORRADOR, SOLO EN MEMORIA: lo escrito en «tus datos» llega al resumen
 * sin pasar por la ruta. Se olvida al confirmar, al soltar o al elegir otro
 * horario; y se pierde (a propósito) si la app se cierra.
 */
const BORRADORES = new Map<string, FormularioDeContratacion>();

export function borradorDe(retencion: string): FormularioDeContratacion {
  return { ...(BORRADORES.get(retencion) ?? formularioVacio()) };
}

export function guardarBorrador(retencion: string, formulario: FormularioDeContratacion): void {
  BORRADORES.set(retencion, { ...formulario });
}

export function olvidarBorrador(retencion: string): void {
  BORRADORES.delete(retencion);
}

// --------------------------------------------------------------------------- //
// Rutas
// --------------------------------------------------------------------------- //
export function rutaDeLaContratacion(retencion: string, paso: '' | 'resumen' | 'condiciones' = ''): string {
  return `/servicios/contratar/${encodeURIComponent(retencion)}${paso ? `/${paso}` : ''}`;
}

export function rutaDeLaReserva(reserva: string): string {
  return `/servicios/reservas/${encodeURIComponent(reserva)}`;
}

export function rutaDeLaReservaDelPrestador(reserva: string): string {
  return `/servicios/prestador/reservas/${encodeURIComponent(reserva)}`;
}

// --------------------------------------------------------------------------- //
// Los errores del servidor, en palabras
// --------------------------------------------------------------------------- //
const ERRORES: Record<string, string> = {
  idempotency_key_required: 'servicios.reserva.error.reintentar',
  service_hold_invalid: 'servicios.reserva.error.horarioInvalido',
  service_slot_not_available: 'servicios.reserva.error.ocupado',
  service_hold_already_active: 'servicios.reserva.error.yaApartado',
  service_hold_limit_reached: 'servicios.reserva.error.demasiadas',
  service_hold_not_found: 'servicios.reserva.error.noEncontrada',
  service_hold_expired: 'servicios.reserva.error.vencida',
  service_hold_not_active: 'servicios.reserva.error.soltada',
  service_hold_already_consumed: 'servicios.reserva.error.yaReservado',
  service_booking_own_service: 'servicios.reserva.error.propio',
  service_booking_service_unavailable: 'servicios.reserva.error.noDisponible',
  service_booking_version_changed: 'servicios.reserva.error.cambio',
  service_booking_payments_not_configured: 'servicios.reserva.error.sinPagos',
  service_booking_price_not_closed: 'servicios.reserva.error.precioAbierto',
  service_booking_quote_required: 'servicios.reserva.error.aConsultar',
  service_booking_provider_confirmation_required: 'servicios.reserva.error.aceptaElPrestador',
  service_booking_terms_unavailable: 'servicios.reserva.error.sinCondiciones',
  service_booking_terms_changed: 'servicios.reserva.error.condicionesCambiaron',
  service_booking_data_invalid: 'servicios.reserva.error.datos',
  service_booking_not_found: 'servicios.reserva.error.reservaNoEncontrada',
  service_booking_busy: 'servicios.reserva.error.ocupadoAhora',
  service_booking_disabled: 'servicios.reserva.error.apagada',
};

export const CODIGOS_DE_ERROR_DE_LA_RESERVA = Object.keys(ERRORES);

export function claveDeErrorDeLaReserva(codigo: string | null | undefined): string | null {
  return codigo ? (ERRORES[codigo] ?? null) : null;
}

/**
 * Tras estos errores el horario APARTADO ya no sirve: se vuelve a elegir.
 * (Otra persona lo tomó, venció, se soltó, el servicio cambió o dejó de estar
 * disponible.)
 */
const HAY_QUE_VOLVER_A_ELEGIR = new Set([
  'service_slot_not_available',
  'service_hold_expired',
  'service_hold_not_active',
  'service_booking_version_changed',
  'service_booking_service_unavailable',
]);

export function hayQueVolverAElegir(codigo: string | null | undefined): boolean {
  return codigo ? HAY_QUE_VOLVER_A_ELEGIR.has(codigo) : false;
}
