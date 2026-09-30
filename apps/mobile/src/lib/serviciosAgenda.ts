/**
 * Z Servicios, Incremento 4: la agenda del prestador y los horarios, del lado
 * del teléfono.
 *
 * LÓGICA PURA, para probarla con `node --test`: los contratos de la API, las
 * claves de traducción de días, tipos, estados, motivos y errores, los
 * formularios (qué rechazaría el servidor, dicho antes y CON LOS LÍMITES QUE
 * MANDA EL SERVIDOR en `limits`) y el horario elegido como valor de la ruta.
 *
 * LO QUE ESTE FICHERO NO DECIDE: si un horario está disponible, qué cruza con
 * qué, qué zona existe, qué día es «hoy» ni a qué hora local cae un instante.
 * Todo eso lo calcula el servidor y llega hecho (`time`, `date`,
 * `utc_offset`, `today`). Aquí no se convierte ninguna zona.
 *
 * NADA SE INVENTA: sin agenda no hay horarios de ejemplo, un motivo que no se
 * conoce no se enseña y la capacidad no se convierte en «quedan».
 *
 * ELEGIR UN HORARIO NO APARTA NADA: se guarda en la ruta, para que el
 * Incremento 5 lo recoja. No se escribe en ninguna parte.
 */
import { fromIso, toIso } from '@/components/DateField.types';
import { pareceZonaIana } from '@/lib/eventoDelOrganizador';

// --------------------------------------------------------------------------- //
// Valores cerrados (los mismos que el servidor; una prueba los compara)
// --------------------------------------------------------------------------- //
export const DIAS = [1, 2, 3, 4, 5, 6, 7] as const;
export const TIPOS_DE_EXCEPCION = ['closed', 'extra', 'replace'] as const;
export type TipoDeExcepcion = (typeof TIPOS_DE_EXCEPCION)[number];
export const ESTADOS_DE_LA_AGENDA = ['active', 'paused'] as const;
export type EstadoDeLaAgenda = (typeof ESTADOS_DE_LA_AGENDA)[number];
/** Lo que dice el calendario: además, «sin configurar». */
export const ESTADOS_DEL_CALENDARIO = ['active', 'paused', 'not_configured'] as const;
/** Por qué el público todavía no ve horarios. */
export const MOTIVOS = [
  'service_not_public',
  'schedule_missing',
  'schedule_paused',
  'service_incomplete',
  'no_availability',
] as const;

// --------------------------------------------------------------------------- //
// Contratos de la API
// --------------------------------------------------------------------------- //
/** Un horario POSIBLE. No está apartado para nadie. */
export type Horario = {
  starts_at: string;
  ends_at: string;
  date: string;
  time: string;
  end_time: string;
  utc_offset: string;
  /** Capacidad TEÓRICA por horario; no es «quedan». */
  capacity: number;
};

export type Regla = {
  id: string;
  weekday: number;
  start: string;
  end: string;
  modality: string;
  capacity: number;
  active: boolean;
};

export type Excepcion = {
  id: string;
  date: string;
  kind: string;
  start: string | null;
  end: string | null;
  modality: string | null;
  capacity: number | null;
};

/** SOLO en la agenda del prestador: lleva el motivo privado. */
export type Bloqueo = {
  id: string;
  starts_at: string;
  ends_at: string;
  start_date: string;
  start_time: string;
  end_date: string;
  end_time: string;
  reason: string | null;
};

export type LimitesDeLaAgenda = {
  notice_minutes: number;
  horizon_days: number;
  grid_minutes: number;
  max_buffer_minutes: number;
  min_interval_minutes: number;
  max_interval_minutes: number;
  max_rules: number;
  max_exceptions: number;
  max_blocks: number;
  max_block_days: number;
  max_advance_days: number;
  reason_max_length: number;
};

export type AgendaPrivada = {
  service_id: string;
  configured: boolean;
  timezone: string | null;
  status: string | null;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  slot_interval_minutes: number | null;
  today: string | null;
  rules: Regla[];
  exceptions: Excepcion[];
  blocks: Bloqueo[];
  service: {
    status: string;
    title: string | null;
    modality: string | null;
    duration_minutes: number | null;
    capacity: number;
    offered_modalities: string[];
    publicly_visible: boolean;
  };
  next_available: Horario | null;
  issues: string[];
  can_edit: boolean;
  limits: LimitesDeLaAgenda;
};

export type Calendario = {
  timezone: string | null;
  status: string;
  modality: string | null;
  duration_minutes: number | null;
  today: string | null;
  last_date: string | null;
  from_date: string | null;
  to_date: string | null;
  days: { date: string; count: number }[];
  next: Horario | null;
  issues: string[];
};

export type PaginaDeHorarios = {
  timezone: string | null;
  status: string;
  date: string;
  modality: string | null;
  duration_minutes: number | null;
  items: Horario[];
  next_cursor: string | null;
};

// --------------------------------------------------------------------------- //
// Claves de traducción
// --------------------------------------------------------------------------- //
function es<T extends string | number>(lista: readonly T[], valor: unknown): valor is T {
  return (lista as readonly unknown[]).includes(valor);
}

export function claveDelDia(dia: number): string {
  return es(DIAS, dia) ? `servicios.agenda.dia.${dia}` : 'servicios.agenda.dia.desconocido';
}

export function claveDelTipo(tipo: string, diaEntero = false): string {
  if (tipo === 'closed') return diaEntero ? 'servicios.agenda.tipo.closedDay' : 'servicios.agenda.tipo.closed';
  return es(TIPOS_DE_EXCEPCION, tipo) ? `servicios.agenda.tipo.${tipo}` : 'servicios.agenda.tipo.desconocido';
}

export function claveDelEstadoDeLaAgenda(estado: string | null | undefined): string {
  return es(ESTADOS_DEL_CALENDARIO, estado ?? 'not_configured')
    ? `servicios.agenda.estado.${estado ?? 'not_configured'}`
    : 'servicios.agenda.estado.not_configured';
}

/** El motivo, o `null` si no se conoce (no se enseña en crudo). */
export function claveDelMotivo(motivo: string): string | null {
  return es(MOTIVOS, motivo) ? `servicios.agenda.motivo.${motivo}` : null;
}

// --------------------------------------------------------------------------- //
// Horas, fechas y horarios (sin zonas: todo llega calculado)
// --------------------------------------------------------------------------- //
/** «09:30» → 570, o `null`. Con la rejilla que dice el servidor. */
export function minutos(texto: string, rejilla: number, admite24: boolean): number | null {
  const m = /^([01]\d|2[0-4]):([0-5]\d)$/.exec(texto.trim());
  if (!m) return null;
  const total = Number(m[1]) * 60 + Number(m[2]);
  if (total > 1440 || (total === 1440 && !admite24)) return null;
  if (rejilla > 0 && total % rejilla !== 0) return null;
  return total;
}

/** «09:00–12:00». */
export function franja(inicio: string | null, fin: string | null): string {
  return inicio && fin ? `${inicio}–${fin}` : '';
}

/** Suma días a una fecha «AAAA-MM-DD» sin pasar por ninguna zona horaria. */
export function sumarDias(iso: string, dias: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const fecha = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + dias));
  return fecha.toISOString().slice(0, 10);
}

/** El día de la semana ISO (1 = lunes) de una fecha de calendario. */
export function diaDeLaSemana(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return 0;
  const dia = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return dia === 0 ? 7 : dia;
}

/** «2026-10-08» → «08/10/2026». */
export function fechaVisible(iso: string | null | undefined): string {
  return iso ? fromIso(iso) || iso : '';
}

/** Cada fecha del rango del calendario, con cuántos horarios tiene (0 si ninguno). */
export function diasDelRango(c: Calendario): { date: string; count: number }[] {
  if (!c.from_date || !c.to_date) return [];
  const cuantos = new Map(c.days.map((d) => [d.date, d.count]));
  const salida: { date: string; count: number }[] = [];
  for (let d = c.from_date; d <= c.to_date && salida.length < 62; d = sumarDias(d, 1)) {
    salida.push({ date: d, count: cuantos.get(d) ?? 0 });
  }
  return salida;
}

/**
 * La hora que se enseña. En la noche en que se atrasa el reloj dos horarios
 * dicen «01:30»: entonces, y solo entonces, se añade el desplazamiento.
 */
export function etiquetaDelHorario(h: Horario, delDia: readonly Horario[]): string {
  const repetida = delDia.some((o) => o !== h && o.time === h.time && o.starts_at !== h.starts_at);
  return repetida ? `${h.time} (UTC${h.utc_offset})` : h.time;
}

/** Junta una página nueva de horarios sin repetir ninguno. */
export function juntarHorarios(ya: readonly Horario[], nuevos: readonly Horario[]): Horario[] {
  const vistos = new Set(ya.map((h) => h.starts_at));
  return [...ya, ...nuevos.filter((h) => !vistos.has(h.starts_at))];
}

/** ¿Hay que avisar de que la hora del teléfono no es la de la agenda? */
export function zonaDistinta(agenda: string | null | undefined, dispositivo: string | null | undefined): boolean {
  return Boolean(agenda && dispositivo && agenda !== dispositivo);
}

/** Las reglas de cada día de la semana, en el orden del servidor. */
export function reglasPorDia(reglas: readonly Regla[]): [number, Regla[]][] {
  return DIAS.map((d) => [d, reglas.filter((r) => r.weekday === d)] as [number, Regla[]]).filter(
    ([, lista]) => lista.length > 0,
  );
}

// --------------------------------------------------------------------------- //
// El horario elegido: SOLO un valor de la ruta, para el Incremento 5
// --------------------------------------------------------------------------- //
/** `hora` es la hora LOCAL que dio el servidor, para enseñarla; `inicio`, el instante. */
export type HorarioElegido = { servicio: string; fecha: string; inicio: string; hora: string; modalidad: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function texto(valor: unknown): string {
  const v = Array.isArray(valor) ? valor[0] : valor;
  return typeof v === 'string' ? v : '';
}

/** Lo elegido, leído de la ruta. Lo que no tiene forma se descarta. */
export function horarioElegidoDesdeRuta(params: Record<string, unknown>): HorarioElegido | null {
  const servicio = texto(params.serviceId);
  const fecha = texto(params.fecha);
  const inicio = texto(params.inicio);
  const hora = texto(params.hora);
  const modalidad = texto(params.modalidad);
  if (
    !UUID.test(servicio) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(fecha) ||
    !INSTANTE.test(inicio) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(hora) ||
    !modalidad
  ) {
    return null;
  }
  return { servicio, fecha, inicio, hora, modalidad };
}

/** Los parámetros que lo guardan en la ruta. Nada más. */
export function rutaDelHorarioElegido(h: Omit<HorarioElegido, 'servicio'>): Record<string, string> {
  return { fecha: h.fecha, inicio: h.inicio, hora: h.hora, modalidad: h.modalidad };
}

// --------------------------------------------------------------------------- //
// Formularios: lo que el servidor rechazaría, dicho antes
// --------------------------------------------------------------------------- //
export type Resultado = { peticion: Record<string, unknown> | null; fallo: string | null };

function entero(valor: string): number | null {
  const limpio = valor.trim();
  if (!/^\d+$/.test(limpio)) return null;
  return Number(limpio);
}

export type FormularioDeAjustes = {
  zona: string;
  estado: EstadoDeLaAgenda;
  preparacion: string;
  descanso: string;
  intervalo: string;
};

export function ajustesDesde(a: AgendaPrivada | null, zonaSugerida = ''): FormularioDeAjustes {
  return {
    zona: a?.timezone ?? zonaSugerida,
    estado: a?.status === 'paused' ? 'paused' : 'active',
    preparacion: String(a?.buffer_before_minutes ?? 0),
    descanso: String(a?.buffer_after_minutes ?? 0),
    intervalo: a?.slot_interval_minutes == null ? '' : String(a.slot_interval_minutes),
  };
}

export function peticionDeAjustes(
  f: FormularioDeAjustes,
  l: LimitesDeLaAgenda,
  confirmarZona = false,
): Resultado {
  const zona = f.zona.trim();
  if (!pareceZonaIana(zona) || zona.startsWith('Etc/')) return { peticion: null, fallo: 'servicios.agenda.error.zona' };
  const separacion = (v: string) => {
    const n = entero(v === '' ? '0' : v);
    return n !== null && n <= l.max_buffer_minutes && n % l.grid_minutes === 0 ? n : null;
  };
  const antes = separacion(f.preparacion);
  const despues = separacion(f.descanso);
  if (antes === null || despues === null) return { peticion: null, fallo: 'servicios.agenda.error.ajustes' };
  let intervalo: number | null = null;
  if (f.intervalo.trim() !== '') {
    intervalo = entero(f.intervalo);
    if (
      intervalo === null ||
      intervalo < l.min_interval_minutes ||
      intervalo > l.max_interval_minutes ||
      intervalo % l.grid_minutes !== 0
    ) {
      return { peticion: null, fallo: 'servicios.agenda.error.ajustes' };
    }
  }
  return {
    peticion: {
      timezone: zona,
      status: f.estado,
      buffer_before_minutes: antes,
      buffer_after_minutes: despues,
      slot_interval_minutes: intervalo,
      ...(confirmarZona ? { confirm_timezone_change: true } : {}),
    },
    fallo: null,
  };
}

export type FormularioDeRegla = {
  dia: number | null;
  inicio: string;
  fin: string;
  modalidad: string | null;
  capacidad: string;
};

export function reglaVacia(modalidad: string | null): FormularioDeRegla {
  return { dia: null, inicio: '', fin: '', modalidad, capacidad: '1' };
}

export function reglaDesde(r: Regla): FormularioDeRegla {
  return { dia: r.weekday, inicio: r.start, fin: r.end, modalidad: r.modality, capacidad: String(r.capacity) };
}

function franjaValida(inicio: string, fin: string, l: LimitesDeLaAgenda): boolean {
  const a = minutos(inicio, l.grid_minutes, false);
  const b = minutos(fin, l.grid_minutes, true);
  return a !== null && b !== null && a < b;
}

function capacidadValida(texto_: string, maxima: number): number | null {
  const n = entero(texto_);
  return n !== null && n >= 1 && n <= maxima ? n : null;
}

export function peticionDeRegla(
  f: FormularioDeRegla,
  l: LimitesDeLaAgenda,
  ofrecidas: readonly string[],
  capacidadMaxima: number,
): Resultado {
  if (f.dia === null || !es(DIAS, f.dia)) return { peticion: null, fallo: 'servicios.agenda.error.dia' };
  if (!franjaValida(f.inicio, f.fin, l)) return { peticion: null, fallo: 'servicios.agenda.error.franja' };
  if (!f.modalidad || !ofrecidas.includes(f.modalidad)) {
    return { peticion: null, fallo: 'servicios.agenda.error.modalidad' };
  }
  const capacidad = capacidadValida(f.capacidad, capacidadMaxima);
  if (capacidad === null) return { peticion: null, fallo: 'servicios.agenda.error.capacidad' };
  return {
    peticion: { weekday: f.dia, start: f.inicio.trim(), end: f.fin.trim(), modality: f.modalidad, capacity: capacidad },
    fallo: null,
  };
}

export type FormularioDeExcepcion = {
  /** dd/mm/aaaa, como el resto de la app. */
  fecha: string;
  tipo: TipoDeExcepcion;
  diaEntero: boolean;
  inicio: string;
  fin: string;
  modalidad: string | null;
  capacidad: string;
};

export function excepcionVacia(modalidad: string | null): FormularioDeExcepcion {
  return { fecha: '', tipo: 'closed', diaEntero: true, inicio: '', fin: '', modalidad, capacidad: '1' };
}

export function excepcionDesde(e: Excepcion): FormularioDeExcepcion {
  return {
    fecha: fromIso(e.date),
    tipo: es(TIPOS_DE_EXCEPCION, e.kind) ? e.kind : 'closed',
    diaEntero: e.kind === 'closed' && e.start === null,
    inicio: e.start ?? '',
    fin: e.end ?? '',
    modalidad: e.modality,
    capacidad: String(e.capacity ?? 1),
  };
}

export function peticionDeExcepcion(
  f: FormularioDeExcepcion,
  l: LimitesDeLaAgenda,
  ofrecidas: readonly string[],
  capacidadMaxima: number,
): Resultado {
  const fecha = toIso(f.fecha);
  if (!fecha) return { peticion: null, fallo: 'servicios.agenda.error.fecha' };
  if (f.tipo === 'closed' && f.diaEntero) {
    return { peticion: { date: fecha, kind: 'closed', start: null, end: null, modality: null, capacity: null }, fallo: null };
  }
  if (!franjaValida(f.inicio, f.fin, l)) return { peticion: null, fallo: 'servicios.agenda.error.franja' };
  if (f.tipo === 'closed') {
    return {
      peticion: { date: fecha, kind: 'closed', start: f.inicio.trim(), end: f.fin.trim(), modality: null, capacity: null },
      fallo: null,
    };
  }
  if (!f.modalidad || !ofrecidas.includes(f.modalidad)) {
    return { peticion: null, fallo: 'servicios.agenda.error.modalidad' };
  }
  const capacidad = capacidadValida(f.capacidad, capacidadMaxima);
  if (capacidad === null) return { peticion: null, fallo: 'servicios.agenda.error.capacidad' };
  return {
    peticion: {
      date: fecha,
      kind: f.tipo,
      start: f.inicio.trim(),
      end: f.fin.trim(),
      modality: f.modalidad,
      capacity: capacidad,
    },
    fallo: null,
  };
}

export type FormularioDeBloqueo = {
  desdeFecha: string;
  desdeHora: string;
  hastaFecha: string;
  hastaHora: string;
  motivo: string;
};

export function bloqueoVacio(): FormularioDeBloqueo {
  return { desdeFecha: '', desdeHora: '', hastaFecha: '', hastaHora: '', motivo: '' };
}

export function peticionDeBloqueo(f: FormularioDeBloqueo, l: LimitesDeLaAgenda): Resultado {
  const desde = toIso(f.desdeFecha);
  const hasta = toIso(f.hastaFecha);
  if (!desde || !hasta) return { peticion: null, fallo: 'servicios.agenda.error.fecha' };
  const a = minutos(f.desdeHora, l.grid_minutes, false);
  const b = minutos(f.hastaHora, l.grid_minutes, true);
  if (a === null || b === null) return { peticion: null, fallo: 'servicios.agenda.error.franja' };
  // Mismo formato (AAAA-MM-DD y minutos): comparar es comparar el orden local.
  if (hasta < desde || (hasta === desde && b <= a)) return { peticion: null, fallo: 'servicios.agenda.error.bloqueo' };
  const motivo = f.motivo.trim();
  if (motivo.length > l.reason_max_length) return { peticion: null, fallo: 'servicios.agenda.error.motivo' };
  return {
    peticion: {
      start_date: desde,
      start_time: f.desdeHora.trim(),
      end_date: hasta,
      end_time: f.hastaHora.trim(),
      reason: motivo === '' ? null : motivo,
    },
    fallo: null,
  };
}

// --------------------------------------------------------------------------- //
// Errores
// --------------------------------------------------------------------------- //
const ERRORES: Record<string, string> = {
  service_schedule_missing: 'servicios.agenda.error.sinAgenda',
  service_schedule_timezone_invalid: 'servicios.agenda.error.zona',
  service_schedule_timezone_unconfirmed: 'servicios.agenda.error.zonaSinConfirmar',
  service_schedule_settings_invalid: 'servicios.agenda.error.ajustes',
  service_schedule_time_invalid: 'servicios.agenda.error.franja',
  service_schedule_exception_invalid: 'servicios.agenda.error.excepcion',
  service_schedule_modality_invalid: 'servicios.agenda.error.modalidad',
  service_schedule_capacity_invalid: 'servicios.agenda.error.capacidad',
  service_schedule_overlap: 'servicios.agenda.error.cruce',
  service_schedule_date_invalid: 'servicios.agenda.error.fecha',
  service_schedule_block_invalid: 'servicios.agenda.error.bloqueo',
  service_schedule_limit_reached: 'servicios.agenda.error.limite',
  service_schedule_item_not_found: 'servicios.agenda.error.noEncontrado',
  service_schedule_block_in_use: 'servicios.agenda.error.bloqueoEnUso',
  service_availability_range_invalid: 'servicios.agenda.error.rango',
  service_availability_out_of_horizon: 'servicios.agenda.error.horizonte',
  service_availability_modality_invalid: 'servicios.agenda.error.modalidad',
};

/** Los códigos propios de la agenda. Una prueba los compara con el servidor. */
export const CODIGOS_DE_ERROR_DE_LA_AGENDA = Object.keys(ERRORES);

export function claveDeErrorDeLaAgenda(codigo: string | null | undefined): string | null {
  return codigo ? (ERRORES[codigo] ?? null) : null;
}
