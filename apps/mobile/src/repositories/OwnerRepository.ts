import { apiRequest, API_V1 } from '@/services/api';
import { profileImageUrl } from '@/services/storage';

/**
 * Lo que ve QUIEN CREÓ un curso, y lo que ve la ADMINISTRACIÓN.
 *
 * Va aparte de `LearningRepository` —que es lo que ve quien estudia— porque son
 * dos audiencias con permisos distintos: aquí cada llamada puede responder 403,
 * y las pantallas tienen que decirlo en vez de quedarse cargando.
 *
 * QUIEN MANDA ES EL SERVIDOR. Esconder un botón no es un permiso: estas
 * funciones se pueden llamar igual desde cualquier sitio y el backend vuelve a
 * comprobar autoría y rol en cada una.
 *
 * Los mapeadores son TOLERANTES a propósito (`?? null`, varios nombres
 * posibles): el dominio comercial se está construyendo en paralelo y un campo
 * que todavía no viaja tiene que dejar la pantalla incompleta, nunca rota.
 */

// ---------------------------------------------------------------------------
// Estudiantes de un curso
// ---------------------------------------------------------------------------

/** De dónde salió el acceso. */
export type FuenteDeAlumno = 'free' | 'entitlement' | 'author' | 'admin' | 'legacy';
/** Por dónde va en el temario. */
export type EstadoDeAvance = 'not_started' | 'in_progress' | 'completed';
/** Si el curso se le sigue abriendo. */
export type EstadoDeAcceso = 'active' | 'revoked' | 'none';
/** Qué pasó con el dinero. NO se enseña en la lista de estudiantes. */
export type EstadoComercialDeAlumno = 'sold' | 'under_review' | 'refunded' | 'none';

/** El filtro de la lista. `revoked` no es un avance: es un acceso retirado. */
export type FiltroDeAlumnos = EstadoDeAvance | 'revoked';

export type AlumnoDelCurso = {
  id: string;
  fullName: string;
  username: string;
  /** Ya resuelta: la fila no vuelve a pedir nada por su cuenta. */
  avatarUrl: string | undefined;
  enrolledAt: string | null;
  source: FuenteDeAlumno;
  lessonsTotal: number;
  lessonsCompleted: number;
  progressPercent: number;
  state: EstadoDeAvance;
  accessState: EstadoDeAcceso;
  commercialState: EstadoComercialDeAlumno;
};

type AlumnoDto = {
  id: string;
  full_name?: string | null;
  username?: string | null;
  avatar_path?: string | null;
  enrolled_at?: string | null;
  source?: string | null;
  lessons_total?: number | null;
  lessons_completed?: number | null;
  progress_percent?: number | null;
  state?: string | null;
  access_state?: string | null;
  commercial_state?: string | null;
};

const FUENTES: readonly FuenteDeAlumno[] = ['free', 'entitlement', 'author', 'admin', 'legacy'];
const AVANCES: readonly EstadoDeAvance[] = ['not_started', 'in_progress', 'completed'];
const ACCESOS: readonly EstadoDeAcceso[] = ['active', 'revoked', 'none'];
const COMERCIALES: readonly EstadoComercialDeAlumno[] = [
  'sold',
  'under_review',
  'refunded',
  'none',
];

/** Un valor del servidor que no esté en la lista NO se pinta como si lo fuera. */
function unoDe<T extends string>(valor: unknown, permitidos: readonly T[], porDefecto: T): T {
  return permitidos.includes(valor as T) ? (valor as T) : porDefecto;
}

function aAlumno(dto: AlumnoDto): AlumnoDelCurso {
  const total = dto.lessons_total ?? 0;
  const hechas = dto.lessons_completed ?? 0;
  return {
    id: dto.id,
    fullName: dto.full_name ?? '',
    username: dto.username ?? '',
    avatarUrl: profileImageUrl(dto.avatar_path),
    enrolledAt: dto.enrolled_at ?? null,
    source: unoDe(dto.source, FUENTES, 'legacy'),
    lessonsTotal: total,
    lessonsCompleted: hechas,
    // Si el servidor no manda el porcentaje se deduce, pero NO se inventa
    // cuando no hay lecciones: sería 0/0 pintado como 0 %.
    progressPercent:
      dto.progress_percent ?? (total > 0 ? Math.round((hechas / total) * 100) : 0),
    state: unoDe(dto.state, AVANCES, 'not_started'),
    accessState: unoDe(dto.access_state, ACCESOS, 'none'),
    commercialState: unoDe(dto.commercial_state, COMERCIALES, 'none'),
  };
}

export type ConsultaDeAlumnos = {
  limit: number;
  offset: number;
  /** Texto libre: nombre o usuario. */
  q?: string;
  state?: FiltroDeAlumnos | null;
};

// ---------------------------------------------------------------------------
// Ventas del curso (lo que ve el PROPIETARIO)
// ---------------------------------------------------------------------------

/** Estados por los que pasa el saldo de una venta. */
export type EstadoDeSaldo =
  | 'pending'
  | 'frozen'
  | 'eligible'
  | 'transferring'
  | 'transferred'
  | 'cancelled';

export const ESTADOS_DE_SALDO: readonly EstadoDeSaldo[] = [
  'pending',
  'frozen',
  'eligible',
  'transferring',
  'transferred',
  'cancelled',
];

export type ResumenDeVentas = {
  studentsPaid: number;
  refunds: number;
  /** Importes agregados, SIEMPRE en unidad menor. */
  grossMinor: number;
  feeMinor: number;
  netMinor: number;
  currency: string;
  /** Cuánto hay en cada estado, en unidad menor. */
  balances: Record<EstadoDeSaldo, number>;
};

export type VentaDelCurso = {
  id: string;
  soldAt: string | null;
  amountMinor: number;
  currency: string;
  balanceState: EstadoDeSaldo;
};

function numero(valor: unknown): number {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : 0;
}

/** El saldo puede llegar como número suelto o dentro de un objeto. */
function importeDeSaldo(valor: unknown): number {
  if (typeof valor === 'number') return numero(valor);
  if (valor && typeof valor === 'object') {
    const objeto = valor as Record<string, unknown>;
    return numero(objeto.amount_minor ?? objeto.amount ?? objeto.total_minor);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Devoluciones (bandeja de ADMINISTRACIÓN)
// ---------------------------------------------------------------------------

export type EstadoDeSolicitudAdmin =
  | 'requested'
  | 'under_review'
  | 'approved'
  | 'refund_processing'
  | 'refunded'
  | 'rejected'
  | 'failed'
  | 'cancelled';

export const ESTADOS_DE_SOLICITUD: readonly EstadoDeSolicitudAdmin[] = [
  'requested',
  'under_review',
  'approved',
  'refund_processing',
  'refunded',
  'rejected',
  'failed',
  'cancelled',
];

export type SolicitudAdmin = {
  id: string;
  status: EstadoDeSolicitudAdmin;
  courseId: string | null;
  courseTitle: string;
  requesterName: string;
  requestedAt: string | null;
  amountMinor: number;
  currency: string;
  /**
   * El identificador del reembolso EN LA PASARELA, si ya se creó.
   *
   * Decide qué se puede hacer en `refund_processing`: con referencia hay algo
   * que conciliar y reintentar duplicaría el reembolso; sin ella no hay nada
   * que preguntar y lo que toca es volver a ejecutarlo.
   */
  externalReference: string | null;
};

/** Un paso del expediente: qué estado, cuándo y quién. */
export type PasoDelHistorial = {
  id: string;
  status: EstadoDeSolicitudAdmin;
  at: string | null;
  actor: string;
  notes: string;
};

export type DetalleDeSolicitud = SolicitudAdmin & {
  reason: string;
  history: PasoDelHistorial[];
};

type SolicitudDto = {
  id: string;
  status?: string | null;
  course_id?: string | null;
  course_title?: string | null;
  requester_name?: string | null;
  requester?: { full_name?: string | null; username?: string | null } | null;
  requested_at?: string | null;
  created_at?: string | null;
  amount_minor?: number | null;
  currency?: string | null;
  reason?: string | null;
  external_refund_id?: string | null;
  external_reference?: string | null;
  history?: Array<{
    id?: string | null;
    status?: string | null;
    at?: string | null;
    created_at?: string | null;
    actor?: string | null;
    actor_name?: string | null;
    notes?: string | null;
  }> | null;
};

function aSolicitud(dto: SolicitudDto): SolicitudAdmin {
  return {
    id: dto.id,
    status: unoDe(dto.status, ESTADOS_DE_SOLICITUD, 'requested'),
    courseId: dto.course_id ?? null,
    courseTitle: dto.course_title ?? '',
    requesterName:
      dto.requester_name ?? dto.requester?.full_name ?? dto.requester?.username ?? '',
    requestedAt: dto.requested_at ?? dto.created_at ?? null,
    amountMinor: numero(dto.amount_minor),
    currency: dto.currency ?? 'PEN',
    externalReference: textoONulo(dto.external_refund_id ?? dto.external_reference),
  };
}

/** Una cadena vacía no es una referencia: se normaliza a `null`. */
function textoONulo(valor: unknown): string | null {
  return typeof valor === 'string' && valor.trim() !== '' ? valor.trim() : null;
}

function aDetalle(dto: SolicitudDto): DetalleDeSolicitud {
  return {
    ...aSolicitud(dto),
    reason: dto.reason ?? '',
    history: (dto.history ?? []).map((paso, indice) => ({
      id: paso.id ?? `${dto.id}-${indice}`,
      status: unoDe(paso.status, ESTADOS_DE_SOLICITUD, 'requested'),
      at: paso.at ?? paso.created_at ?? null,
      actor: paso.actor_name ?? paso.actor ?? '',
      notes: paso.notes ?? '',
    })),
  };
}

/**
 * Las acciones de la bandeja, en el vocabulario de la PANTALLA.
 *
 * `execute` (pedir el reembolso desde `approved`) y `retry` (repetirlo tras un
 * fallo) son la misma operación en el servidor y hoy comparten endpoint; se
 * distinguen aquí porque el aviso y la etiqueta que lee un administrador no son
 * los mismos. Si el backend les da rutas distintas, solo cambia la tabla
 * `ENDPOINT_DE_ACCION`.
 */
export type AccionDeDevolucion =
  | 'take'
  | 'approve'
  | 'reject'
  | 'cancel'
  | 'execute'
  | 'retry'
  | 'reconcile';

/** Las que mueven dinero: piden aviso antes de ejecutarse. */
export const ACCIONES_FINANCIERAS: readonly AccionDeDevolucion[] = [
  'approve',
  'execute',
  'retry',
  'reconcile',
];

/** Qué ruta llama cada acción. El único sitio donde vive el nombre real. */
const ENDPOINT_DE_ACCION: Record<AccionDeDevolucion, string> = {
  take: 'take',
  approve: 'approve',
  reject: 'reject',
  cancel: 'cancel',
  // El backend mantiene `/retry` sirviendo también para `approved`.
  execute: 'retry',
  retry: 'retry',
  reconcile: 'reconcile',
};

function queryDe(params: Record<string, string | number | null | undefined>): string {
  const partes: string[] = [];
  for (const [nombre, valor] of Object.entries(params)) {
    if (valor === null || valor === undefined || valor === '') continue;
    partes.push(`${nombre}=${encodeURIComponent(String(valor))}`);
  }
  return partes.length > 0 ? `?${partes.join('&')}` : '';
}

export const OwnerRepository = {
  /**
   * Quién está inscrito en un curso. SOLO su autor o la administración: el
   * servidor responde 403 a cualquier otro, y la pantalla lo dice.
   */
  async estudiantes(courseId: string, consulta: ConsultaDeAlumnos): Promise<AlumnoDelCurso[]> {
    const dtos = await apiRequest<AlumnoDto[]>(
      `${API_V1}/learning/courses/${courseId}/students${queryDe({
        limit: consulta.limit,
        offset: consulta.offset,
        q: consulta.q,
        state: consulta.state,
      })}`,
    );
    return (dtos ?? []).map(aAlumno);
  },

  /** El resumen comercial del curso: cuánto entró, cuánto se fue y qué queda. */
  async resumenDeVentas(courseId: string): Promise<ResumenDeVentas> {
    const dto = await apiRequest<Record<string, unknown>>(
      `${API_V1}/commerce/courses/${courseId}/summary`,
    );
    const saldos = (dto.balances ?? {}) as Record<string, unknown>;
    const balances = {} as Record<EstadoDeSaldo, number>;
    for (const estado of ESTADOS_DE_SALDO) balances[estado] = importeDeSaldo(saldos[estado]);
    return {
      studentsPaid: numero(dto.students_paid ?? dto.paid_students),
      refunds: numero(dto.refunds ?? dto.refunds_count),
      grossMinor: numero(dto.gross_minor ?? dto.gross_amount_minor),
      feeMinor: numero(dto.fee_minor ?? dto.commission_minor),
      netMinor: numero(dto.net_minor ?? dto.net_amount_minor),
      currency: typeof dto.currency === 'string' ? dto.currency : 'PEN',
      balances,
    };
  },

  /**
   * Las ventas del curso, paginadas.
   *
   * NO trae —ni se pide— nada del comprador: quién compró no es asunto del
   * balance, y su nombre junto a un importe convertiría esta pantalla en una
   * ficha financiera de otra persona.
   */
  async ventas(courseId: string, limit: number, offset: number): Promise<VentaDelCurso[]> {
    const dtos = await apiRequest<
      Array<{
        id: string;
        sold_at?: string | null;
        created_at?: string | null;
        amount_minor?: number | null;
        currency?: string | null;
        balance_state?: string | null;
        status?: string | null;
      }>
    >(`${API_V1}/commerce/courses/${courseId}/sales${queryDe({ limit, offset })}`);
    return (dtos ?? []).map((dto) => ({
      id: dto.id,
      soldAt: dto.sold_at ?? dto.created_at ?? null,
      amountMinor: numero(dto.amount_minor),
      currency: dto.currency ?? 'PEN',
      balanceState: unoDe(dto.balance_state ?? dto.status, ESTADOS_DE_SALDO, 'pending'),
    }));
  },

  /** La bandeja de administración. */
  async solicitudes(consulta: {
    status?: EstadoDeSolicitudAdmin | null;
    q?: string;
    limit: number;
    offset: number;
  }): Promise<SolicitudAdmin[]> {
    const dtos = await apiRequest<SolicitudDto[]>(
      `${API_V1}/admin/refund-requests${queryDe({
        status: consulta.status,
        q: consulta.q,
        limit: consulta.limit,
        offset: consulta.offset,
      })}`,
    );
    return (dtos ?? []).map(aSolicitud);
  },

  /** Una solicitud con su HISTORIAL de estados: sin él no hay expediente. */
  async solicitud(id: string): Promise<DetalleDeSolicitud> {
    const dto = await apiRequest<SolicitudDto>(`${API_V1}/admin/refund-requests/${id}`);
    return aDetalle(dto);
  },

  /**
   * Ejecuta una acción sobre una solicitud.
   *
   * `notes` viaja siempre que haya algo escrito, y es OBLIGATORIO para
   * rechazar: un rechazo sin motivo deja a quien lo pidió sin nada que leer.
   * Lo vuelve a exigir el servidor.
   */
  async accion(
    id: string,
    accion: AccionDeDevolucion,
    notes?: string,
  ): Promise<DetalleDeSolicitud> {
    const texto = (notes ?? '').trim();
    const dto = await apiRequest<SolicitudDto>(
      `${API_V1}/admin/refund-requests/${id}/${ENDPOINT_DE_ACCION[accion]}`,
      { method: 'POST', body: JSON.stringify({ notes: texto }) },
    );
    // Algunas acciones devuelven la solicitud entera y otras solo confirman:
    // si no viene nada útil, la pantalla recarga el detalle por su cuenta.
    return aDetalle({ ...(dto ?? {}), id: dto?.id ?? id });
  },
};
