/**
 * Z Servicios, Incremento 6: la atención de una reserva y su posventa. Lo que
 * la app necesita saber de ellas, SIN DECIDIR NADA.
 *
 * TRES COSAS QUE AQUÍ NO SE HACEN, a propósito:
 *
 *   * DECIDIR QUÉ SE PUEDE HACER. El servidor manda `care.available_actions`
 *     con cada reserva y la app enseña solo eso: ni mira la hora del teléfono,
 *     ni adivina por el estado.
 *   * DAR POR HECHO UN DINERO QUE NO SE MOVIÓ. Un caso resuelto «a favor» no
 *     es una devolución: lo económico es lo que se SOLICITÓ y su estado
 *     (`not_applicable`, `pending`, `blocked`). Ninguno dice «devuelto».
 *   * INVENTAR UNA NOTA. Sin reseñas publicadas el promedio es `null`, y se
 *     dice «todavía no hay reseñas», nunca «0,0».
 */
import type { ReservaDetalle } from '@/lib/serviciosReserva';

// --------------------------------------------------------------------------- //
// Los valores cerrados (los del servidor; una prueba los compara)
// --------------------------------------------------------------------------- //
/** Lo que puede venir en `care.available_actions`. */
export const ACCIONES_DE_LA_ATENCION = [
  'cancel',
  'reschedule',
  'issue_code',
  'start',
  'complete',
  'confirm',
  'report_absence',
  'open_incident',
  'add_incident_entry',
  'withdraw_incident',
  'appeal_incident',
  'review',
  'reply_review',
] as const;
export type AccionDeLaAtencion = (typeof ACCIONES_DE_LA_ATENCION)[number];

export const ESTADOS_DE_LA_RESERVA = ['confirmed', 'cancelled'] as const;
export const ESTADOS_DE_LA_ATENCION = [
  'code_issued',
  'in_progress',
  'completed',
  'closed',
  'no_show_client',
  'no_show_provider',
] as const;
export const CIERRES_DE_LA_ATENCION = ['client', 'system', 'admin'] as const;
export const ESTADOS_DEL_CASO = ['open', 'resolved', 'appealed', 'closed', 'withdrawn'] as const;
export const MOTIVOS_DEL_CASO = [
  'provider_absent',
  'client_absent',
  'incomplete',
  'different_service',
  'quality',
  'safety',
  'technical',
  'other',
] as const;
/** Qué motivo puede alegar cada parte: nadie se reporta ausente a sí mismo. */
export const MOTIVOS_DE_CADA_PARTE = {
  client: ['provider_absent', 'incomplete', 'different_service', 'quality', 'safety', 'technical', 'other'],
  provider: ['client_absent', 'safety', 'technical', 'other'],
} as const;
export type Parte = keyof typeof MOTIVOS_DE_CADA_PARTE;

export const MOTIVOS_DE_CANCELACION = ['change_of_plans', 'unavailable', 'operational', 'other'] as const;
export const RESULTADOS_DEL_CASO = ['upheld', 'partially_upheld', 'rejected'] as const;
export const EFECTOS_EN_LA_ATENCION = ['none', 'completed', 'provider_no_show', 'client_no_show'] as const;
/** EL DINERO: lo que se SOLICITA… */
export const EFECTOS_ECONOMICOS = ['none', 'full_refund', 'partial_refund'] as const;
/** …y en qué queda. No existe «ejecutado»: eso solo podrá decirlo una pasarela. */
export const ESTADOS_DEL_EFECTO = ['not_applicable', 'pending', 'blocked'] as const;
export const TIPOS_DE_ENTRADA = ['message', 'evidence', 'resolution', 'appeal', 'internal_note'] as const;
export const ESTADOS_DE_LA_RESENA = ['pending', 'published', 'hidden'] as const;
export const EJES_DE_LA_RESENA = ['fulfillment', 'quality', 'punctuality', 'clarity'] as const;
export type EjeDeLaResena = (typeof EJES_DE_LA_RESENA)[number];
/** Por qué se esconde una reseña: lista cerrada. «Es negativa» no existe. */
export const MOTIVOS_DE_MODERACION = ['personal_data', 'threat', 'hate', 'extortion', 'off_topic', 'other'] as const;

/** Los mismos largos que la 0094 y `reserva_politica.py` (una prueba los compara). */
export const LARGOS_DE_LA_ATENCION = {
  codigo: 6,
  descripcionMinima: 20,
  descripcion: 2000,
  entrada: 2000,
  nota: 500,
  comentarioMinimo: 20,
  comentario: 2000,
  respuesta: 1000,
  evidencias: 10,
} as const;

/** Una evidencia: PDF o foto, hasta 10 MB (lo vuelve a comprobar el servidor, por sus bytes). */
export const FORMATOS_DE_EVIDENCIA = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;
export const PESO_MAXIMO_DE_EVIDENCIA = 10 * 1024 * 1024;

// --------------------------------------------------------------------------- //
// Lo que llega del servidor
// --------------------------------------------------------------------------- //
export type Atencion = {
  status: string;
  started_at: string | null;
  completed_at: string | null;
  confirmed_at: string | null;
  closed_at: string | null;
  closed_by: string | null;
  /** LA SEÑAL FUERTE: empezó con el código de quien contrata. */
  with_code: boolean;
  /** Solo a quien contrata, y solo mientras la atención no empezó. */
  checkin_code: string | null;
  /** Solo al prestador. */
  code_attempts_left: number | null;
};

export type Plazos = {
  cancel_until: string;
  reschedule_until: string;
  reschedules_left: number;
  checkin_opens_at: string;
  absence_from: string;
  incident_until: string;
  review_until: string | null;
  appeal_until: string | null;
  cancellation_financial_effect: string;
};

export type Resena = {
  id: string;
  author_id: string | null;
  rating: number;
  fulfillment: number | null;
  quality: number | null;
  punctuality: number | null;
  clarity: number | null;
  recommends: boolean;
  comment: string;
  verified: boolean;
  reply: string | null;
  replied_at: string | null;
  created_at: string;
  /** Solo en la propia y en moderación. */
  status: string | null;
};

export type Cuidado = {
  available_actions: string[];
  attendance: Atencion | null;
  cancellation: { by: string; reason: string; note: string | null; at: string; financial_effect_status: string } | null;
  reschedules: { from_starts_at: string; to_starts_at: string; at: string }[];
  deadlines: Plazos;
  incident: { id: string; status: string; reason: string; opened_by_me: boolean; outcome: string | null } | null;
  review: Resena | null;
};

/** El detalle de una reserva con su atención. Sin la 0094, `care` es `null`. */
export type ConCuidado<T extends ReservaDetalle = ReservaDetalle> = T & { care?: Cuidado | null };

export type Entrada = {
  id: string;
  kind: string;
  author_role: string;
  mine: boolean;
  body: string | null;
  content_type: string | null;
  byte_size: number | null;
  created_at: string;
};

export type Expediente = {
  id: string;
  booking_id: string;
  status: string;
  reason: string;
  description: string;
  opened_by_me: boolean;
  created_at: string;
  outcome: string | null;
  attention_effect: string | null;
  financial_effect: string | null;
  financial_effect_status: string | null;
  resolved_at: string | null;
  appealed_by: string | null;
  appealed_at: string | null;
  appeal_until: string | null;
  entries: Entrada[];
  available_actions: string[];
};

export type CasoAdmin = {
  id: string;
  booking_id: string;
  booking_code: string;
  title: string;
  provider_name: string;
  status: string;
  reason: string;
  created_at: string;
  outcome: string | null;
  financial_effect: string | null;
  financial_effect_status: string | null;
  resolutions: number;
};

export type ExpedienteAdmin = Expediente & {
  booking_code: string;
  title: string;
  provider_name: string;
  starts_at: string;
  booking_status: string;
  resolutions: number;
};

export type ResenaAdmin = Resena & { booking_id: string; service_id: string };

export type ResumenDeResenas = {
  total: number;
  average: number | null;
  recommend_bps: number | null;
  by_axis: Record<string, number | null>;
};

export type PaginaDeResenas = {
  /** Falso si las reseñas todavía no están disponibles: la ficha no enseña la sección. */
  available: boolean;
  items: Resena[];
  next_cursor: string | null;
  summary: ResumenDeResenas | null;
};

export type Tareas = { reminded: number; closed: number; unverified: number; skipped: number };

// --------------------------------------------------------------------------- //
// Lo que se puede hacer: LO DICE EL SERVIDOR
// --------------------------------------------------------------------------- //
/** Si el servidor ofrece esa acción AHORA. Sin `care` (sin la 0094), ninguna. */
export function puede(cuidado: Cuidado | null | undefined, accion: AccionDeLaAtencion): boolean {
  return !!cuidado && cuidado.available_actions.includes(accion);
}

/** Lo mismo, sobre el expediente de un caso. */
export function puedeEnElCaso(expediente: Pick<Expediente, 'available_actions'> | null, accion: AccionDeLaAtencion): boolean {
  return !!expediente && expediente.available_actions.includes(accion);
}

// --------------------------------------------------------------------------- //
// Palabras
// --------------------------------------------------------------------------- //
function es<T extends string>(lista: readonly T[], valor: unknown): valor is T {
  return typeof valor === 'string' && (lista as readonly string[]).includes(valor);
}

function clave(prefijo: string, lista: readonly string[], valor: string | null | undefined): string {
  return es(lista, valor) ? `${prefijo}.${valor}` : `${prefijo}.otro`;
}

export function claveDelEstadoDeLaReserva(estado: string | null | undefined): string {
  return clave('servicios.atencion.reserva', ESTADOS_DE_LA_RESERVA, estado);
}

/** El estado de la atención; sin atención todavía, «por atender». */
export function claveDelEstadoDeLaAtencion(estado: string | null | undefined): string {
  return estado ? clave('servicios.atencion.estado', ESTADOS_DE_LA_ATENCION, estado) : 'servicios.atencion.estado.ninguno';
}

export function claveDelCierre(quien: string | null | undefined): string {
  return clave('servicios.atencion.cierre', CIERRES_DE_LA_ATENCION, quien);
}

export function claveDelEstadoDelCaso(estado: string | null | undefined): string {
  return clave('servicios.atencion.caso.estado', ESTADOS_DEL_CASO, estado);
}

export function claveDelMotivoDelCaso(motivo: string | null | undefined): string {
  return clave('servicios.atencion.caso.motivo', MOTIVOS_DEL_CASO, motivo);
}

export function claveDelMotivoDeCancelacion(motivo: string | null | undefined): string {
  return clave('servicios.atencion.cancelar.motivo', MOTIVOS_DE_CANCELACION, motivo);
}

export function claveDelResultado(resultado: string | null | undefined): string {
  return clave('servicios.atencion.caso.resultado', RESULTADOS_DEL_CASO, resultado);
}

export function claveDelEfectoEnLaAtencion(efecto: string | null | undefined): string {
  return clave('servicios.atencion.caso.efecto', EFECTOS_EN_LA_ATENCION, efecto);
}

export function claveDelEfectoEconomico(efecto: string | null | undefined): string {
  return clave('servicios.atencion.dinero.efecto', EFECTOS_ECONOMICOS, efecto);
}

/** En qué quedó lo económico. Lo desconocido NO se lee como «hecho». */
export function claveDelEstadoDelEfecto(estado: string | null | undefined): string {
  return clave('servicios.atencion.dinero.estado', ESTADOS_DEL_EFECTO, estado);
}

export function claveDelTipoDeEntrada(tipo: string | null | undefined): string {
  return clave('servicios.atencion.caso.entrada', TIPOS_DE_ENTRADA, tipo);
}

export function claveDeQuienEscribe(rol: string | null | undefined, mia: boolean): string {
  if (mia) return 'servicios.atencion.caso.autor.yo';
  return clave('servicios.atencion.caso.autor', ['client', 'provider', 'admin'], rol);
}

export function claveDelEstadoDeLaResena(estado: string | null | undefined): string {
  return clave('servicios.atencion.resena.estado', ESTADOS_DE_LA_RESENA, estado);
}

export function claveDelEje(eje: string): string {
  return clave('servicios.atencion.resena.eje', EJES_DE_LA_RESENA, eje);
}

export function claveDelMotivoDeModeracion(motivo: string | null | undefined): string {
  return clave('servicios.atencion.moderar.motivo', MOTIVOS_DE_MODERACION, motivo);
}

/**
 * Lo que se pregunta ANTES de una acción que no se deshace: su título, lo que
 * implica y el botón que la confirma.
 */
export const PREGUNTAS_DE_LA_ATENCION = {
  sinCodigo: {
    titulo: 'servicios.atencion.pregunta.sinCodigo.titulo',
    aviso: 'servicios.atencion.pregunta.sinCodigo.aviso',
    si: 'servicios.atencion.pregunta.sinCodigo.si',
  },
  terminar: {
    titulo: 'servicios.atencion.pregunta.terminar.titulo',
    aviso: 'servicios.atencion.pregunta.terminar.aviso',
    si: 'servicios.atencion.pregunta.terminar.si',
  },
  confirmar: {
    titulo: 'servicios.atencion.pregunta.confirmar.titulo',
    aviso: 'servicios.atencion.pregunta.confirmar.aviso',
    si: 'servicios.atencion.pregunta.confirmar.si',
  },
  ausenciaDelPrestador: {
    titulo: 'servicios.atencion.pregunta.ausenciaDelPrestador.titulo',
    aviso: 'servicios.atencion.pregunta.ausenciaDelPrestador.aviso',
    si: 'servicios.atencion.pregunta.ausenciaDelPrestador.si',
  },
  ausenciaDelCliente: {
    titulo: 'servicios.atencion.pregunta.ausenciaDelCliente.titulo',
    aviso: 'servicios.atencion.pregunta.ausenciaDelCliente.aviso',
    si: 'servicios.atencion.pregunta.ausenciaDelCliente.si',
  },
  responder: {
    titulo: 'servicios.atencion.pregunta.responder.titulo',
    aviso: 'servicios.atencion.pregunta.responder.aviso',
    si: 'servicios.atencion.pregunta.responder.si',
  },
} as const;
export type PreguntaDeLaAtencion = keyof typeof PREGUNTAS_DE_LA_ATENCION;

// --------------------------------------------------------------------------- //
// Fechas: un instante del servidor, en la hora del teléfono
// --------------------------------------------------------------------------- //
/** «dd/mm/aaaa hh:mm», o cadena vacía si no es un instante. */
export function momentoLegible(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const dos = (n: number) => String(n).padStart(2, '0');
  return `${dos(d.getDate())}/${dos(d.getMonth() + 1)}/${d.getFullYear()} ${dos(d.getHours())}:${dos(d.getMinutes())}`;
}

// --------------------------------------------------------------------------- //
// Las reseñas, en palabras
// --------------------------------------------------------------------------- //
export type Frase = { clave: string; params?: Record<string, string | number> };

/** SIN RESEÑAS NO HAY NOTA: ni «0,0» ni estrellas vacías. */
export function promedioLegible(resumen: ResumenDeResenas | null | undefined): Frase {
  const total = resumen?.total ?? 0;
  const media = resumen?.average ?? null;
  if (total <= 0 || media === null || !Number.isFinite(media)) return { clave: 'servicios.atencion.resenas.ninguna' };
  return { clave: 'servicios.atencion.resenas.media', params: { media: media.toFixed(1), n: total } };
}

/** «El 80 % la recomienda», o `null` si no hay con qué decirlo. */
export function recomendacionLegible(resumen: ResumenDeResenas | null | undefined): Frase | null {
  const puntos = resumen?.recommend_bps ?? null;
  if (!resumen || resumen.total <= 0 || puntos === null) return null;
  return { clave: 'servicios.atencion.resenas.recomiendan', params: { porcentaje: Math.round(puntos / 100) } };
}

/** «★★★★☆» para leer de un vistazo; lo accesible es el número. */
export function estrellas(nota: number): string {
  const n = Math.max(0, Math.min(5, Math.round(nota)));
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

// --------------------------------------------------------------------------- //
// Lo que se manda (el servidor lo vuelve a comprobar todo)
// --------------------------------------------------------------------------- //
export type Resultado = { peticion: Record<string, unknown> | null; fallo: string | null };

/** Cancelar: un motivo de la lista y, si cancela EL PRESTADOR, por qué. */
export function peticionDeCancelacion(rol: Parte, motivo: string, nota: string): Resultado {
  if (!es(MOTIVOS_DE_CANCELACION, motivo)) return { peticion: null, fallo: 'servicios.atencion.error.motivo' };
  const limpia = nota.trim();
  if (limpia.length > LARGOS_DE_LA_ATENCION.nota) return { peticion: null, fallo: 'servicios.atencion.error.largo' };
  if (rol === 'provider' && !limpia) return { peticion: null, fallo: 'servicios.atencion.error.explica' };
  return { peticion: { reason: motivo, note: limpia || null }, fallo: null };
}

/** Abrir un caso: un motivo de los de ESA parte y qué pasó. */
export function peticionDelCaso(rol: Parte, motivo: string | null, descripcion: string): Resultado {
  if (!motivo || !(MOTIVOS_DE_CADA_PARTE[rol] as readonly string[]).includes(motivo)) {
    return { peticion: null, fallo: 'servicios.atencion.error.motivo' };
  }
  const limpia = descripcion.trim();
  if (limpia.length < LARGOS_DE_LA_ATENCION.descripcionMinima) {
    return { peticion: null, fallo: 'servicios.atencion.error.descripcionCorta' };
  }
  if (limpia.length > LARGOS_DE_LA_ATENCION.descripcion) return { peticion: null, fallo: 'servicios.atencion.error.largo' };
  return { peticion: { reason: motivo, description: limpia }, fallo: null };
}

/** Un mensaje al expediente (o la apelación, que exige explicarse). */
export function peticionDeMensaje(texto: string, minimo = 1): Resultado {
  const limpio = texto.trim();
  if (limpio.length < minimo) {
    return { peticion: null, fallo: minimo > 1 ? 'servicios.atencion.error.descripcionCorta' : 'servicios.atencion.error.vacio' };
  }
  if (limpio.length > LARGOS_DE_LA_ATENCION.entrada) return { peticion: null, fallo: 'servicios.atencion.error.largo' };
  return { peticion: { body: limpio }, fallo: null };
}

export type FormularioDeResena = {
  nota: number;
  ejes: Partial<Record<EjeDeLaResena, number>>;
  recomienda: boolean | null;
  comentario: string;
};

export function resenaVacia(): FormularioDeResena {
  return { nota: 0, ejes: {}, recomienda: null, comentario: '' };
}

const esNota = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 5;

/** La reseña: una nota de 1 a 5, si la recomienda y un comentario. Los ejes, opcionales. */
export function peticionDeResena(f: FormularioDeResena): Resultado {
  if (!esNota(f.nota)) return { peticion: null, fallo: 'servicios.atencion.error.nota' };
  if (f.recomienda === null) return { peticion: null, fallo: 'servicios.atencion.error.recomienda' };
  const comentario = f.comentario.trim();
  if (comentario.length < LARGOS_DE_LA_ATENCION.comentarioMinimo) {
    return { peticion: null, fallo: 'servicios.atencion.error.comentarioCorto' };
  }
  if (comentario.length > LARGOS_DE_LA_ATENCION.comentario) return { peticion: null, fallo: 'servicios.atencion.error.largo' };
  const peticion: Record<string, unknown> = { rating: f.nota, recommends: f.recomienda, comment: comentario };
  for (const eje of EJES_DE_LA_RESENA) {
    const valor = f.ejes[eje];
    if (valor !== undefined && valor !== 0) {
      if (!esNota(valor)) return { peticion: null, fallo: 'servicios.atencion.error.nota' };
      peticion[eje] = valor;
    }
  }
  return { peticion, fallo: null };
}

/** La respuesta pública del prestador: una, y no se reescribe. */
export function peticionDeRespuesta(texto: string): Resultado {
  const limpio = texto.trim();
  if (!limpio) return { peticion: null, fallo: 'servicios.atencion.error.vacio' };
  if (limpio.length > LARGOS_DE_LA_ATENCION.respuesta) return { peticion: null, fallo: 'servicios.atencion.error.largo' };
  return { peticion: { reply: limpio }, fallo: null };
}

export type FormularioDeResolucion = {
  resultado: string | null;
  texto: string;
  efectoEnLaAtencion: string;
  efectoEconomico: string;
  notaInterna: string;
};

export function resolucionVacia(): FormularioDeResolucion {
  return { resultado: null, texto: '', efectoEnLaAtencion: 'none', efectoEconomico: 'none', notaInterna: '' };
}

/**
 * La resolución de un caso. Dice, POR SEPARADO: qué se decidió, su efecto en
 * la atención y el efecto económico que se SOLICITA. El estado de ese efecto
 * NO se manda: lo decide el servidor, y nunca es «ejecutado».
 */
export function peticionDeResolucion(f: FormularioDeResolucion): Resultado {
  if (!es(RESULTADOS_DEL_CASO, f.resultado)) return { peticion: null, fallo: 'servicios.atencion.error.resultado' };
  if (!es(EFECTOS_EN_LA_ATENCION, f.efectoEnLaAtencion) || !es(EFECTOS_ECONOMICOS, f.efectoEconomico)) {
    return { peticion: null, fallo: 'servicios.atencion.error.resultado' };
  }
  const texto = f.texto.trim();
  const nota = f.notaInterna.trim();
  if (!texto) return { peticion: null, fallo: 'servicios.atencion.error.explica' };
  if (texto.length > LARGOS_DE_LA_ATENCION.entrada || nota.length > LARGOS_DE_LA_ATENCION.entrada) {
    return { peticion: null, fallo: 'servicios.atencion.error.largo' };
  }
  return {
    peticion: {
      outcome: f.resultado,
      resolution: texto,
      attention_effect: f.efectoEnLaAtencion,
      financial_effect: f.efectoEconomico,
      internal_note: nota || null,
    },
    fallo: null,
  };
}

/** Publicar o esconder una reseña. Esconder exige un motivo de la lista. */
export function peticionDeModeracion(accion: 'publish' | 'hide', motivo: string | null): Resultado {
  if (accion === 'publish') return { peticion: { action: 'publish' }, fallo: null };
  if (!es(MOTIVOS_DE_MODERACION, motivo)) return { peticion: null, fallo: 'servicios.atencion.error.motivo' };
  return { peticion: { action: 'hide', reason: motivo }, fallo: null };
}

/** El código de asistencia que escribe el prestador: seis cifras, o nada. */
export function codigoLimpio(texto: string): string {
  return texto.replace(/\D/g, '').slice(0, LARGOS_DE_LA_ATENCION.codigo);
}

// --------------------------------------------------------------------------- //
// La clave de idempotencia de cada acción
// --------------------------------------------------------------------------- //
/**
 * UNA CLAVE POR PETICIÓN. Repetir lo mismo (un doble toque, un reintento tras
 * perder la conexión) usa la misma clave y el servidor contesta lo mismo;
 * cambiar lo que se manda es otra petición, con otra clave. Al terminar bien,
 * `hecho` la olvida.
 */
export function llavero(nueva: () => string) {
  const claves = new Map<string, { firma: string; valor: string }>();
  return {
    de(accion: string, peticion: unknown = null): string {
      const firma = JSON.stringify(peticion);
      const actual = claves.get(accion);
      if (actual && actual.firma === firma) return actual.valor;
      const valor = nueva();
      claves.set(accion, { firma, valor });
      return valor;
    },
    hecho(accion: string): void {
      claves.delete(accion);
    },
  };
}

// --------------------------------------------------------------------------- //
// Rutas: identificadores, nada más
// --------------------------------------------------------------------------- //
function baseDe(rol: Parte, reserva: string): string {
  const id = encodeURIComponent(reserva);
  return rol === 'client' ? `/servicios/reservas/${id}` : `/servicios/prestador/reservas/${id}`;
}

export function rutaDeCancelar(rol: Parte, reserva: string): string {
  return `${baseDe(rol, reserva)}/cancelar`;
}

export function rutaDelCaso(rol: Parte, reserva: string): string {
  return `${baseDe(rol, reserva)}/caso`;
}

export function rutaDeLaResena(reserva: string): string {
  return `${baseDe('client', reserva)}/resena`;
}

/** Elegir OTRO horario del mismo servicio, para mover esa reserva. */
export function rutaDeHorariosParaReprogramar(servicio: string, reserva: string): string {
  return `/servicios/horarios/${encodeURIComponent(servicio)}?reprogramar=${encodeURIComponent(reserva)}`;
}

/** Confirmar el cambio, con el horario ya apartado. */
export function rutaDeReprogramar(reserva: string, retencion: string): string {
  return `${baseDe('client', reserva)}/reprogramar?retencion=${encodeURIComponent(retencion)}`;
}

export function rutaDelCasoParaAdministrar(caso: string): string {
  return `/admin/servicios/casos/${encodeURIComponent(caso)}`;
}

// --------------------------------------------------------------------------- //
// Los errores del servidor, en palabras
// --------------------------------------------------------------------------- //
const ERRORES: Record<string, string> = {
  service_booking_already_cancelled: 'servicios.atencion.error.yaCancelada',
  service_booking_action_not_available: 'servicios.atencion.error.yaNoSePuede',
  service_booking_reschedule_too_late: 'servicios.atencion.error.reprogramarTarde',
  service_booking_reschedule_limit: 'servicios.atencion.error.reprogramarAgotado',
  service_booking_reason_required: 'servicios.atencion.error.explica',
  service_attention_not_in_window: 'servicios.atencion.error.fueraDeHora',
  service_attention_code_invalid: 'servicios.atencion.error.codigo',
  service_attention_code_blocked: 'servicios.atencion.error.codigoBloqueado',
  service_attention_incident_open: 'servicios.atencion.error.casoAbierto',
  service_attention_provider_not_active: 'servicios.atencion.error.prestadorInactivo',
  service_incident_not_found: 'servicios.atencion.error.casoNoEncontrado',
  service_incident_exists: 'servicios.atencion.error.casoYaExiste',
  service_incident_window_closed: 'servicios.atencion.error.casoFueraDePlazo',
  service_incident_not_open: 'servicios.atencion.error.casoCerrado',
  service_incident_invalid: 'servicios.atencion.error.casoInvalido',
  service_incident_appeal_not_allowed: 'servicios.atencion.error.apelacion',
  service_incident_resolver_conflict: 'servicios.atencion.error.otraPersona',
  service_incident_effect_not_allowed: 'servicios.atencion.error.efecto',
  service_incident_evidence_limit: 'servicios.atencion.error.demasiadasEvidencias',
  service_evidence_unavailable: 'servicios.atencion.error.evidencia',
  service_evidence_storage_not_configured: 'servicios.atencion.error.evidencia',
  service_review_not_allowed: 'servicios.atencion.error.resenaTodaviaNo',
  service_review_exists: 'servicios.atencion.error.resenaYaExiste',
  service_review_not_found: 'servicios.atencion.error.resenaNoEncontrada',
  service_review_invalid: 'servicios.atencion.error.resenaInvalida',
  service_review_already_replied: 'servicios.atencion.error.yaRespondida',
  service_review_moderation_not_allowed: 'servicios.atencion.error.moderacion',
};

export const CODIGOS_DE_ERROR_DE_LA_ATENCION = Object.keys(ERRORES);

export function claveDeErrorDeLaAtencion(codigo: string | null | undefined): string | null {
  return codigo ? (ERRORES[codigo] ?? null) : null;
}
