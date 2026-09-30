/**
 * Z Servicios, Incremento 1: la admisión del prestador, del lado del teléfono.
 *
 * PURO Y SIN IMPORTS en tiempo de ejecución, para probarlo con `node --test`:
 * aquí están los contratos de la API, las claves de traducción de cada estado,
 * requisito y error, y las validaciones que el teléfono hace ANTES de mandar
 * algo. Quien pinta traduce y navega.
 *
 * LO QUE ESTE FICHERO NO DECIDE: qué falta para enviar, qué impide aprobar ni
 * qué botones se enseñan. Todo eso lo dice el servidor (`missing`,
 * `approval_blockers`, `available_actions`, `can_submit`, `can_resubmit`,
 * `can_withdraw`); aquí solo se traduce. Si el teléfono lo calculara, una
 * versión vieja instalada enseñaría un botón que el servidor ya no acepta.
 *
 * NINGÚN CÓDIGO INTERNO LLEGA A LA PANTALLA: un código que no se conoce se
 * traduce a un texto genérico, nunca se imprime tal cual.
 */

// --------------------------------------------------------------------------- //
// Valores cerrados (los mismos que el servidor)
// --------------------------------------------------------------------------- //
export const ESTADOS = [
  'draft',
  'submitted',
  'under_review',
  'changes_requested',
  'resubmitted',
  'approved',
  'rejected',
  'suspended',
  'withdrawn',
] as const;
export type EstadoDePostulacion = (typeof ESTADOS)[number];

export const TIPOS_DE_PRESTADOR = ['individual', 'company'] as const;
export type TipoDePrestador = (typeof TIPOS_DE_PRESTADOR)[number];

export const TIPOS_DE_DOCUMENTO = [
  'identity',
  'legal_representation',
  'tax_registration',
  'proof_of_address',
  'professional_title',
  'professional_license',
  'insurance',
  'portfolio',
  'other',
] as const;
export type TipoDeDocumento = (typeof TIPOS_DE_DOCUMENTO)[number];

export const TIPOS_DE_CREDENCIAL = [
  'professional_title',
  'professional_license',
  'professional_registration',
  'certification',
  'insurance',
  'other',
] as const;
export type TipoDeCredencial = (typeof TIPOS_DE_CREDENCIAL)[number];

/** Los campos del borrador que Z puede pedir corregir (`requisitos.CAMPOS_OBSERVABLES`). */
export const CAMPOS_OBSERVABLES = [
  'provider_type',
  'display_name',
  'legal_name',
  'country_code',
  'tax_id',
  'representative_name',
  'summary',
  'requested_category',
] as const;
export type CampoObservable = (typeof CAMPOS_OBSERVABLES)[number];

/** Los formatos que admite el depósito privado (0088) y su peso máximo. */
export const FORMATOS_DE_DOCUMENTO = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export const PESO_MAXIMO_DE_DOCUMENTO = 10 * 1024 * 1024;

/** Lo que tarda de verdad una subida de 10 MB con mala conexión. */
export const ESPERA_DE_SUBIDA_MS = 120_000;

/** Las acciones que el servidor puede ofrecer en `available_actions`. */
export const ACCIONES = ['start_review', 'request_changes', 'approve', 'reject', 'suspend'] as const;
export type AccionDeAdministracion = (typeof ACCIONES)[number];

// --------------------------------------------------------------------------- //
// Contratos (lo que devuelve la API; ver `services/schemas.py`)
// --------------------------------------------------------------------------- //
export type PrestadorPrivado = {
  id: string;
  provider_type: TipoDePrestador;
  display_name: string;
  legal_name: string | null;
  country_code: string | null;
  tax_id: string | null;
  representative_name: string | null;
  status: 'pending' | 'active' | 'suspended';
};

export type DocumentoPrivado = {
  id: string;
  kind: string;
  content_type: string;
  byte_size: number;
  /** `pending`, `accepted` o `rejected` (observado). */
  review_status: string;
  review_note: string | null;
  created_at: string | null;
  can_remove: boolean;
  can_replace: boolean;
};

export type CredencialPrivada = {
  id: string;
  kind: string;
  title: string;
  issuer: string;
  jurisdiction: string | null;
  /** SOLO ENMASCARADO: el número completo nunca viaja. */
  number_masked: string | null;
  specialty: string | null;
  issued_on: string | null;
  expires_on: string | null;
  /** `pending`, `observed`, `verified`, `rejected` o `expired`. */
  display_status: string;
  review_note: string | null;
  evidence_document_id: string | null;
  can_edit: boolean;
  can_remove: boolean;
};

export type SolicitudPrivada = {
  id: string;
  status: EstadoDePostulacion;
  provider: PrestadorPrivado;
  summary: string | null;
  requested_category: string | null;
  submitted_at: string | null;
  last_submitted_at: string | null;
  decided_at: string | null;
  suspended_at: string | null;
  applicant_message: string | null;
  observed_fields: string[];
  terms: { policy_id: string; version: number | null; accepted_at: string | null } | null;
  documents: DocumentoPrivado[];
  credentials: CredencialPrivada[];
  editable: boolean;
  missing: string[];
  can_submit: boolean;
  can_resubmit: boolean;
  can_withdraw: boolean;
  submissions_count: number;
  created_at: string | null;
  updated_at: string | null;
};

export type Terminos = {
  policy_id: string;
  version: number;
  country_code: string;
  category: string | null;
  title: string;
  body: string;
  sha256: string;
  effective_at: string | null;
};

export type EventoVisible = {
  from_status: string | null;
  to_status: string;
  by: 'you' | 'z';
  visible_note: string | null;
  fields: string[];
  created_at: string | null;
};

export type EnlaceTemporal = { url: string; expires_in: number };

export type PrestadorAdmin = PrestadorPrivado & {
  profile_id: string;
  activated_at: string | null;
  suspended_at: string | null;
  created_at: string | null;
};

export type DocumentoAdmin = {
  id: string;
  kind: string;
  content_type: string;
  byte_size: number;
  review_status: string;
  review_note: string | null;
  created_at: string | null;
  application_id: string;
  reviewed_at: string | null;
  lifecycle: string;
  replaced_by: string | null;
};

export type CredencialAdmin = CredencialPrivada & {
  status: string;
  verified_at: string | null;
  observed_at: string | null;
};

export type Envio = {
  sequence: number;
  kind: 'submitted' | 'resubmitted';
  terms_policy_id: string;
  terms_version: number;
  terms_sha256: string;
  snapshot_sha256: string;
  created_at: string | null;
};

export type SolicitudAdmin = {
  id: string;
  status: EstadoDePostulacion;
  provider: PrestadorAdmin;
  summary: string | null;
  requested_category: string | null;
  terms_policy_id: string | null;
  terms_version: number | null;
  terms_accepted_at: string | null;
  truthfulness_declared_at: string | null;
  submitted_at: string | null;
  last_submitted_at: string | null;
  review_started_at: string | null;
  decided_at: string | null;
  suspended_at: string | null;
  applicant_message: string | null;
  internal_notes: string | null;
  observed_fields: string[];
  documents: DocumentoAdmin[];
  replaced_documents: DocumentoAdmin[];
  credentials: CredencialAdmin[];
  submissions: Envio[];
  approval_blockers: string[];
  available_actions: string[];
  is_own: boolean;
  created_at: string | null;
  updated_at: string | null;
};

export type SolicitudResumen = {
  id: string;
  status: EstadoDePostulacion;
  provider_type: TipoDePrestador;
  display_name: string;
  requested_category: string | null;
  submitted_at: string | null;
  last_submitted_at: string | null;
  updated_at: string | null;
};

export type PaginaDeSolicitudes = { items: SolicitudResumen[]; next_cursor: string | null };

export type EventoAdmin = {
  id: string;
  from_status: string | null;
  to_status: string;
  actor_role: string;
  visible_note: string | null;
  internal_note: string | null;
  details: { fields?: string[]; submission?: number; terms_version?: number };
  created_at: string | null;
};

/** Las condiciones del PRESTADOR (Inc. 1) o las de CONTRATACIÓN (Inc. 5). */
export type TipoDePolitica = 'provider_terms' | 'booking_terms';

export type Politica = {
  id: string;
  kind: string;
  country_code: string;
  category: string | null;
  version: number;
  status: 'draft' | 'published' | 'superseded' | 'withdrawn';
  title: string;
  body: string;
  body_sha256: string;
  parameters: Record<string, unknown>;
  effective_at: string | null;
  published_at: string | null;
};

// --------------------------------------------------------------------------- //
// Claves de traducción
// --------------------------------------------------------------------------- //
function esUno<T extends string>(lista: readonly T[], valor: string): valor is T {
  return (lista as readonly string[]).includes(valor);
}

/** El nombre de un estado. Uno desconocido NO se imprime tal cual. */
export function claveDelEstado(estado: string): string {
  return esUno(ESTADOS, estado) ? `servicios.estado.${estado}` : 'servicios.estado.desconocido';
}

/** Lo que significa ese estado para quien postula, en una frase. */
export function claveDelCuerpoDelEstado(estado: string): string {
  return esUno(ESTADOS, estado)
    ? `servicios.estadoCuerpo.${estado}`
    : 'servicios.estadoCuerpo.desconocido';
}

export function claveDelTipoDePrestador(tipo: string): string {
  return esUno(TIPOS_DE_PRESTADOR, tipo) ? `servicios.tipo.${tipo}` : 'servicios.tipo.desconocido';
}

export function claveDelTipoDeDocumento(tipo: string): string {
  return esUno(TIPOS_DE_DOCUMENTO, tipo)
    ? `servicios.documento.${tipo}`
    : 'servicios.documento.other';
}

export function claveDelTipoDeCredencial(tipo: string): string {
  return esUno(TIPOS_DE_CREDENCIAL, tipo)
    ? `servicios.tipoCredencial.${tipo}`
    : 'servicios.tipoCredencial.other';
}

const ESTADOS_DE_DOCUMENTO = ['pending', 'accepted', 'rejected'] as const;
export function claveDelEstadoDeDocumento(estado: string): string {
  return esUno(ESTADOS_DE_DOCUMENTO, estado)
    ? `servicios.estadoDocumento.${estado}`
    : 'servicios.estadoDocumento.pending';
}

const ESTADOS_DE_CREDENCIAL = ['pending', 'observed', 'verified', 'rejected', 'expired'] as const;
export function claveDelEstadoDeCredencial(estado: string): string {
  return esUno(ESTADOS_DE_CREDENCIAL, estado)
    ? `servicios.estadoCredencial.${estado}`
    : 'servicios.estadoCredencial.pending';
}

export function claveDelCampo(campo: string): string {
  return esUno(CAMPOS_OBSERVABLES, campo) ? `servicios.campo.${campo}` : 'servicios.campo.otro';
}

/** Un requisito traducido: la frase y, si la lleva, el nombre de lo que falta. */
export type Requisito = { clave: string; nombre?: string };

/**
 * Un código de `missing` (qué falta para enviar o reenviar), traducido.
 *
 * `nombre` es OTRA clave (el documento, la credencial o el campo) que la
 * pantalla traduce y mete en el hueco `{nombre}` de la frase.
 */
export function requisito(codigo: string): Requisito {
  const [base, resto] = codigo.includes(':')
    ? [codigo.slice(0, codigo.indexOf(':')), codigo.slice(codigo.indexOf(':') + 1)]
    : [codigo, ''];
  switch (base) {
    case 'legal_name':
    case 'country_code':
    case 'summary':
    case 'tax_id':
    case 'representative_name':
      return { clave: 'servicios.falta.campo', nombre: claveDelCampo(base) };
    case 'document':
      return { clave: 'servicios.falta.documento', nombre: claveDelTipoDeDocumento(resto) };
    case 'credential':
      return { clave: 'servicios.falta.credencial', nombre: claveDelTipoDeCredencial(resto) };
    case 'credential_evidence':
      return { clave: 'servicios.falta.evidencia' };
    case 'provider_terms_not_published':
      return { clave: 'servicios.falta.condicionesSinPublicar' };
    case 'provider_terms_not_accepted':
      return { clave: 'servicios.falta.condicionesSinAceptar' };
    case 'provider_terms_changed':
      return { clave: 'servicios.falta.condicionesCambiaron' };
    case 'document_observed':
      return { clave: 'servicios.falta.documentoObservado', nombre: claveDelTipoDeDocumento(resto) };
    case 'credential_observed':
      return { clave: 'servicios.falta.credencialObservada' };
    case 'field_not_corrected':
      return { clave: 'servicios.falta.campoSinCorregir', nombre: claveDelCampo(resto) };
    default:
      return { clave: 'servicios.falta.otro' };
  }
}

/** Un código de `approval_blockers` (qué impide aprobar), traducido. */
export function bloqueo(codigo: string): Requisito {
  const [base, resto] = codigo.includes(':')
    ? [codigo.slice(0, codigo.indexOf(':')), codigo.slice(codigo.indexOf(':') + 1)]
    : [codigo, ''];
  switch (base) {
    case 'document_pending_review':
      return { clave: 'servicios.bloqueo.documentoSinRevisar', nombre: claveDelTipoDeDocumento(resto) };
    case 'document_observed':
      return { clave: 'servicios.bloqueo.documentoObservado', nombre: claveDelTipoDeDocumento(resto) };
    case 'document_not_accepted':
      return { clave: 'servicios.bloqueo.documentoSinAceptar', nombre: claveDelTipoDeDocumento(resto) };
    case 'credential_pending_review':
      return { clave: 'servicios.bloqueo.credencialSinRevisar' };
    case 'credential_not_verified':
      return { clave: 'servicios.bloqueo.credencialSinVerificar', nombre: claveDelTipoDeCredencial(resto) };
    default:
      return { clave: 'servicios.bloqueo.otro' };
  }
}

/**
 * El nombre del botón de una acción de administración.
 *
 * `start_review` sobre una SUSPENDIDA no es «tomar»: es devolverla a revisión
 * para investigar, y el botón lo dice.
 */
export function claveDeLaAccion(accion: string, estado: string): string {
  if (accion === 'start_review' && estado === 'suspended') return 'servicios.admin.accion.volverARevision';
  return esUno(ACCIONES, accion) ? `servicios.admin.accion.${accion}` : 'servicios.admin.accion.otra';
}

/** Qué acciones exigen motivo, y cuáles son destructivas. */
export function exigeMotivo(accion: string): boolean {
  return accion === 'request_changes' || accion === 'reject' || accion === 'suspend';
}
export function esDestructiva(accion: string): boolean {
  return accion === 'reject' || accion === 'suspend';
}

// --------------------------------------------------------------------------- //
// Errores
// --------------------------------------------------------------------------- //
const ERRORES: Record<string, string> = {
  services_disabled: 'servicios.error.noDisponible',
  services_not_ready: 'servicios.error.noDisponible',
  service_application_not_found: 'servicios.error.noEncontrada',
  service_application_not_editable: 'servicios.error.noEditable',
  service_application_incomplete: 'servicios.error.incompleta',
  service_application_corrections_pending: 'servicios.error.correccionesPendientes',
  service_application_requirements_pending: 'servicios.error.requisitosPendientes',
  service_application_transition_invalid: 'servicios.error.yaCambio',
  service_application_transition_forbidden: 'servicios.error.sinPermiso',
  service_application_already_decided: 'servicios.error.yaDecidida',
  service_application_country_required: 'servicios.error.paisRequerido',
  service_application_field_not_editable: 'servicios.error.noEditable',
  service_application_field_required: 'servicios.error.datoObligatorio',
  service_application_field_unknown: 'servicios.error.datosInvalidos',
  service_application_status_unknown: 'servicios.error.datosInvalidos',
  service_provider_type_unknown: 'servicios.error.datosInvalidos',
  service_reapplication_not_configured: 'servicios.error.repostulacionSinDecidir',
  service_reapplication_not_allowed: 'servicios.error.repostulacionNoPermitida',
  service_review_forbidden: 'servicios.error.sinPermiso',
  service_decision_forbidden: 'servicios.error.soloAdministracion',
  service_self_review_forbidden: 'servicios.error.propia',
  provider_terms_not_published: 'servicios.error.condicionesSinPublicar',
  provider_terms_changed: 'servicios.error.condicionesCambiaron',
  service_policy_not_found: 'servicios.error.noEncontrada',
  service_policy_not_editable: 'servicios.error.politicaPublicada',
  service_policy_parameters_invalid: 'servicios.error.parametrosInvalidos',
  service_document_not_found: 'servicios.error.documentoNoEncontrado',
  service_document_locked: 'servicios.error.documentoBloqueado',
  service_document_submitted: 'servicios.error.documentoEnviado',
  service_document_in_use: 'servicios.error.documentoEnUso',
  service_document_empty: 'servicios.error.documentoVacio',
  service_document_too_big: 'servicios.error.documentoPesado',
  service_document_type_invalid: 'servicios.error.documentoFormato',
  service_document_kind_invalid: 'servicios.error.datosInvalidos',
  service_document_too_many: 'servicios.error.documentoDemasiados',
  service_document_note_required: 'servicios.error.motivoRequerido',
  service_document_invalid: 'servicios.error.datosInvalidos',
  service_storage_not_configured: 'servicios.error.almacenamiento',
  service_storage_failed: 'servicios.error.almacenamiento',
  service_credential_not_found: 'servicios.error.credencialNoEncontrada',
  service_credential_locked: 'servicios.error.credencialBloqueada',
  service_credential_submitted: 'servicios.error.credencialEnviada',
  service_credential_evidence_invalid: 'servicios.error.evidenciaInvalida',
  service_credential_evidence_required: 'servicios.error.evidenciaRequerida',
  service_credential_expired: 'servicios.error.credencialVencida',
  service_credential_note_required: 'servicios.error.motivoRequerido',
  service_credential_too_many: 'servicios.error.credencialDemasiadas',
  service_credential_dates_invalid: 'servicios.error.fechasInvalidas',
  service_credential_invalid: 'servicios.error.datosInvalidos',
  service_credential_action_invalid: 'servicios.error.datosInvalidos',
  idempotency_key_reused: 'servicios.error.yaCambio',
  idempotency_key_invalid: 'servicios.error.datosInvalidos',
  invalid_cursor: 'servicios.error.datosInvalidos',
  validation_error: 'servicios.error.datosInvalidos',
};

/** Los códigos que conoce el teléfono. Una prueba los compara con el servidor. */
export const CODIGOS_DE_ERROR = Object.keys(ERRORES);

export function claveDeErrorDeServicios(codigo: string | null | undefined): string | null {
  return codigo ? (ERRORES[codigo] ?? null) : null;
}

export function claveDeErrorPorEstado(estado: number): string | null {
  if (estado === 401) return 'servicios.error.sinSesion';
  if (estado === 403) return 'servicios.error.sinPermiso';
  if (estado === 404) return 'servicios.error.noEncontrada';
  if (estado === 409) return 'servicios.error.yaCambio';
  if (estado === 422) return 'servicios.error.datosInvalidos';
  if (estado === 503) return 'servicios.error.noDisponible';
  return null;
}

export function esServiciosApagado(codigo: string | null | undefined): boolean {
  return codigo === 'services_disabled' || codigo === 'services_not_ready';
}

export function esFalloDeRed(codigo: string | null | undefined): boolean {
  return codigo === 'network_error' || codigo === 'timeout';
}

/** Por qué no se pudo CARGAR una pantalla. Decide si se ofrece reintentar. */
export type FalloDeCarga = 'apagado' | 'sinSesion' | 'sinPermiso' | 'noEncontrada' | 'sinConexion' | 'error';

export function falloDeCarga(estado: number, codigo: string | null | undefined): FalloDeCarga {
  if (esServiciosApagado(codigo)) return 'apagado';
  if (esFalloDeRed(codigo)) return 'sinConexion';
  if (estado === 401) return 'sinSesion';
  if (estado === 403) return 'sinPermiso';
  if (estado === 404) return 'noEncontrada';
  return 'error';
}

/** Los fallos que se arreglan reintentando; los demás, no. */
export function seReintenta(fallo: FalloDeCarga): boolean {
  return fallo === 'sinConexion' || fallo === 'error';
}

/**
 * Si tras un error hay que volver a leer del servidor: alguien cambió el
 * expediente mientras tanto (409) o ya no existe (404). Nunca se asume el
 * resultado: se pinta lo que diga el servidor.
 */
export function hayQueRecargar(estado: number, codigo: string | null | undefined): boolean {
  return estado === 409 || estado === 404 || codigo === 'provider_terms_changed';
}

// --------------------------------------------------------------------------- //
// Formularios
// --------------------------------------------------------------------------- //
export type Fallo = { campo: string; clave: string };

export type FormularioDeDatos = {
  tipo: TipoDePrestador;
  nombre: string;
  nombreLegal: string;
  pais: string;
  ruc: string;
  representante: string;
  resumen: string;
  categoria: string;
};

export const LARGOS = {
  nombre: [2, 120],
  nombreLegal: [2, 200],
  ruc: [5, 20],
  representante: [2, 200],
  resumen: [20, 4000],
  categoria: [2, 80],
} as const;

export function formularioDesde(solicitud: SolicitudPrivada): FormularioDeDatos {
  const p = solicitud.provider;
  return {
    tipo: p.provider_type,
    nombre: p.display_name ?? '',
    nombreLegal: p.legal_name ?? '',
    pais: p.country_code ?? '',
    ruc: p.tax_id ?? '',
    representante: p.representative_name ?? '',
    resumen: solicitud.summary ?? '',
    categoria: solicitud.requested_category ?? '',
  };
}

/**
 * Los CAMBIOS del borrador, solo de lo que cambió, y los fallos de forma.
 *
 * Un campo vaciado viaja como `null` (el servidor lo vacía); uno que no cambió
 * no viaja. Los mínimos son los del servidor, que vuelve a comprobarlo todo.
 * No se exige NADA aquí para guardar: qué falta para ENVIAR lo dice el servidor.
 */
export function cambiosDelBorrador(
  formulario: FormularioDeDatos,
  solicitud: SolicitudPrivada,
): { cambios: Record<string, string | null>; fallos: Fallo[] } {
  const actual = formularioDesde(solicitud);
  const fallos: Fallo[] = [];
  const cambios: Record<string, string | null> = {};
  const texto = (v: string) => v.trim();

  const medir = (campo: keyof typeof LARGOS, valor: string, obligatorio = false) => {
    const [minimo, maximo] = LARGOS[campo];
    if (valor === '' && !obligatorio) return;
    if (valor.length < minimo) fallos.push({ campo, clave: 'servicios.validacion.corto' });
    else if (valor.length > maximo) fallos.push({ campo, clave: 'servicios.validacion.largo' });
  };

  const nombre = texto(formulario.nombre);
  medir('nombre', nombre, true);
  const nombreLegal = texto(formulario.nombreLegal);
  medir('nombreLegal', nombreLegal);
  const pais = texto(formulario.pais).toUpperCase();
  if (pais !== '' && !/^[A-Z]{2}$/.test(pais)) {
    fallos.push({ campo: 'pais', clave: 'servicios.validacion.pais' });
  }
  const ruc = texto(formulario.ruc);
  medir('ruc', ruc);
  const representante = texto(formulario.representante);
  medir('representante', representante);
  const resumen = texto(formulario.resumen);
  medir('resumen', resumen);
  const categoria = texto(formulario.categoria);
  medir('categoria', categoria);

  if (formulario.tipo !== actual.tipo) cambios.provider_type = formulario.tipo;
  if (nombre !== actual.nombre) cambios.display_name = nombre;
  const opcional = (clave: string, nuevo: string, viejo: string) => {
    if (nuevo !== viejo) cambios[clave] = nuevo === '' ? null : nuevo;
  };
  opcional('legal_name', nombreLegal, actual.nombreLegal);
  opcional('country_code', pais, actual.pais);
  opcional('tax_id', ruc, actual.ruc);
  opcional('representative_name', representante, actual.representante);
  opcional('summary', resumen, actual.resumen);
  opcional('requested_category', categoria, actual.categoria);
  return { cambios, fallos };
}

/** El alta: tipo y nombre visible. */
export function peticionDeAlta(
  tipo: TipoDePrestador | null,
  nombre: string,
): { peticion: { provider_type: TipoDePrestador; display_name: string } | null; fallos: Fallo[] } {
  const fallos: Fallo[] = [];
  if (tipo === null) fallos.push({ campo: 'tipo', clave: 'servicios.validacion.elegirTipo' });
  const limpio = nombre.trim();
  if (limpio.length < LARGOS.nombre[0]) fallos.push({ campo: 'nombre', clave: 'servicios.validacion.corto' });
  else if (limpio.length > LARGOS.nombre[1]) fallos.push({ campo: 'nombre', clave: 'servicios.validacion.largo' });
  if (fallos.length > 0 || tipo === null) return { peticion: null, fallos };
  return { peticion: { provider_type: tipo, display_name: limpio }, fallos };
}

/** dd/mm/aaaa (lo que escribe `DateField`) → aaaa-mm-dd, o `null` si no es una fecha. */
export function fechaIso(campo: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(campo.trim());
  if (!m) return null;
  const [, dd, mm, aaaa] = m;
  const fecha = new Date(Date.UTC(Number(aaaa), Number(mm) - 1, Number(dd)));
  if (
    fecha.getUTCFullYear() !== Number(aaaa) ||
    fecha.getUTCMonth() !== Number(mm) - 1 ||
    fecha.getUTCDate() !== Number(dd)
  ) {
    return null;
  }
  return `${aaaa}-${mm}-${dd}`;
}

/** aaaa-mm-dd → dd/mm/aaaa, para rellenar `DateField`. */
export function fechaDeCampo(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

export type FormularioDeCredencial = {
  tipo: TipoDeCredencial | null;
  titulo: string;
  emisor: string;
  jurisdiccion: string;
  numero: string;
  especialidad: string;
  emitida: string;
  vence: string;
  evidencia: string | null;
};

export function credencialVacia(): FormularioDeCredencial {
  return {
    tipo: null,
    titulo: '',
    emisor: '',
    jurisdiccion: '',
    numero: '',
    especialidad: '',
    emitida: '',
    vence: '',
    evidencia: null,
  };
}

/** Para editar: el número NO se rellena (solo se conoce enmascarado). */
export function credencialDesde(c: CredencialPrivada): FormularioDeCredencial {
  return {
    tipo: esUno(TIPOS_DE_CREDENCIAL, c.kind) ? c.kind : 'other',
    titulo: c.title,
    emisor: c.issuer,
    jurisdiccion: c.jurisdiction ?? '',
    numero: '',
    especialidad: c.specialty ?? '',
    emitida: fechaDeCampo(c.issued_on),
    vence: fechaDeCampo(c.expires_on),
    evidencia: c.evidence_document_id,
  };
}

/**
 * La petición de una credencial. Al CREAR van todos los campos con valor; al
 * EDITAR solo los que cambiaron (y el número solo si se escribió uno nuevo).
 */
export function peticionDeCredencial(
  formulario: FormularioDeCredencial,
  anterior: CredencialPrivada | null,
): { peticion: Record<string, string | null> | null; fallos: Fallo[] } {
  const fallos: Fallo[] = [];
  if (anterior === null && formulario.tipo === null) {
    fallos.push({ campo: 'tipo', clave: 'servicios.validacion.elegirTipo' });
  }
  const medir = (campo: string, valor: string, minimo: number, maximo: number, obligatorio: boolean) => {
    if (valor === '') {
      if (obligatorio) fallos.push({ campo, clave: 'servicios.validacion.obligatorio' });
      return;
    }
    if (valor.length < minimo) fallos.push({ campo, clave: 'servicios.validacion.corto' });
    else if (valor.length > maximo) fallos.push({ campo, clave: 'servicios.validacion.largo' });
  };
  const titulo = formulario.titulo.trim();
  const emisor = formulario.emisor.trim();
  const jurisdiccion = formulario.jurisdiccion.trim();
  const numero = formulario.numero.trim();
  const especialidad = formulario.especialidad.trim();
  medir('titulo', titulo, 2, 200, true);
  medir('emisor', emisor, 2, 200, true);
  medir('jurisdiccion', jurisdiccion, 2, 120, false);
  medir('numero', numero, 1, 64, false);
  medir('especialidad', especialidad, 2, 200, false);

  const emitida = formulario.emitida.trim() === '' ? null : fechaIso(formulario.emitida);
  const vence = formulario.vence.trim() === '' ? null : fechaIso(formulario.vence);
  if (formulario.emitida.trim() !== '' && emitida === null) {
    fallos.push({ campo: 'emitida', clave: 'servicios.validacion.fecha' });
  }
  if (formulario.vence.trim() !== '' && vence === null) {
    fallos.push({ campo: 'vence', clave: 'servicios.validacion.fecha' });
  }
  if (emitida && vence && vence < emitida) {
    fallos.push({ campo: 'vence', clave: 'servicios.validacion.venceAntes' });
  }
  if (fallos.length > 0) return { peticion: null, fallos };

  const nulo = (v: string) => (v === '' ? null : v);
  if (anterior === null) {
    const peticion: Record<string, string | null> = {
      kind: formulario.tipo as string,
      title: titulo,
      issuer: emisor,
    };
    if (jurisdiccion) peticion.jurisdiction = jurisdiccion;
    if (numero) peticion.number = numero;
    if (especialidad) peticion.specialty = especialidad;
    if (emitida) peticion.issued_on = emitida;
    if (vence) peticion.expires_on = vence;
    if (formulario.evidencia) peticion.evidence_document_id = formulario.evidencia;
    return { peticion, fallos };
  }
  const antes = credencialDesde(anterior);
  const peticion: Record<string, string | null> = {};
  if (titulo !== antes.titulo) peticion.title = titulo;
  if (emisor !== antes.emisor) peticion.issuer = emisor;
  if (jurisdiccion !== antes.jurisdiccion) peticion.jurisdiction = nulo(jurisdiccion);
  if (numero !== '') peticion.number = numero;
  if (especialidad !== antes.especialidad) peticion.specialty = nulo(especialidad);
  if (formulario.emitida.trim() !== antes.emitida) peticion.issued_on = emitida;
  if (formulario.vence.trim() !== antes.vence) peticion.expires_on = vence;
  if (formulario.evidencia !== antes.evidencia) peticion.evidence_document_id = formulario.evidencia;
  if (Object.keys(peticion).length === 0) {
    return { peticion: null, fallos: [{ campo: 'titulo', clave: 'servicios.validacion.sinCambios' }] };
  }
  return { peticion, fallos };
}

/** El motivo de una decisión: obligatorio donde el servidor lo exige. */
export function revisarMotivo(accion: string, texto: string): string | null {
  const limpio = texto.trim();
  if (limpio === '') return exigeMotivo(accion) ? 'servicios.validacion.motivoObligatorio' : null;
  if (limpio.length < 3) return 'servicios.validacion.corto';
  if (limpio.length > 2000) return 'servicios.validacion.largo';
  return null;
}

/** El motivo de una observación (documento o credencial): 3 a 1000. */
export function revisarNota(texto: string): string | null {
  const limpio = texto.trim();
  if (limpio === '') return 'servicios.validacion.motivoObligatorio';
  if (limpio.length < 3) return 'servicios.validacion.corto';
  if (limpio.length > 1000) return 'servicios.validacion.largo';
  return null;
}

/** El motivo, OPCIONAL, de una retirada: si se escribe, 3 a 500. */
export function revisarMotivoDeRetirada(texto: string): string | null {
  const limpio = texto.trim();
  if (limpio === '') return null;
  if (limpio.length < 3) return 'servicios.validacion.corto';
  if (limpio.length > 500) return 'servicios.validacion.largo';
  return null;
}

// --------------------------------------------------------------------------- //
// Pasos y estado del asistente
// --------------------------------------------------------------------------- //
export const PASOS = ['datos', 'condiciones', 'documentos', 'credenciales', 'resumen'] as const;
export type Paso = (typeof PASOS)[number];

/**
 * En qué paso está cada código de `missing`. Así el asistente marca un paso
 * como listo SOLO cuando el servidor ya no pide nada de él.
 */
export function pasoDelRequisito(codigo: string): Paso {
  const base = codigo.split(':')[0] ?? '';
  if (base.startsWith('provider_terms')) return 'condiciones';
  if (base === 'document' || base === 'document_observed') return 'documentos';
  if (base.startsWith('credential')) return 'credenciales';
  if (base === 'field_not_corrected') return 'datos';
  if (['legal_name', 'country_code', 'summary', 'tax_id', 'representative_name'].includes(base)) {
    return 'datos';
  }
  return 'resumen';
}

export function pasosPendientes(solicitud: Pick<SolicitudPrivada, 'missing'>): Set<Paso> {
  return new Set(solicitud.missing.map(pasoDelRequisito));
}

/** Qué documentos pide el servidor que todavía no están (de `missing`). */
export function documentosQueFaltan(solicitud: Pick<SolicitudPrivada, 'missing'>): string[] {
  return solicitud.missing
    .filter((c) => c.startsWith('document:'))
    .map((c) => c.slice('document:'.length));
}

/** Si esta postulación ya terminó y se puede empezar otra. */
export function esFinal(estado: string): boolean {
  return estado === 'rejected' || estado === 'withdrawn';
}

/** Si quien postula puede seguir escribiendo. Lo dice el servidor (`editable`). */
export function sePuedeEscribir(solicitud: Pick<SolicitudPrivada, 'editable'>): boolean {
  return solicitud.editable === true;
}

// --------------------------------------------------------------------------- //
// Bandeja de administración
// --------------------------------------------------------------------------- //
/** Los filtros de la bandeja. `null` = lo que espera a Z (lo de fábrica). */
export const FILTROS_DE_ESTADO: (EstadoDePostulacion | null)[] = [
  null,
  'submitted',
  'under_review',
  'resubmitted',
  'changes_requested',
  'approved',
  'rejected',
  'suspended',
  'withdrawn',
];
export const FILTROS_DE_TIPO: (TipoDePrestador | null)[] = [null, 'individual', 'company'];
export const TAMANO_DE_PAGINA = 20;

export function consultaDeLaBandeja(opciones: {
  estado: EstadoDePostulacion | null;
  tipo: TipoDePrestador | null;
  cursor: string | null;
  limite?: number;
}): string {
  const q: string[] = [`limit=${opciones.limite ?? TAMANO_DE_PAGINA}`];
  if (opciones.estado) q.push(`status=${encodeURIComponent(opciones.estado)}`);
  if (opciones.tipo) q.push(`provider_type=${encodeURIComponent(opciones.tipo)}`);
  if (opciones.cursor) q.push(`cursor=${encodeURIComponent(opciones.cursor)}`);
  return q.join('&');
}

/** Junta una página nueva sin repetir filas (un reintento puede traer la misma). */
export function juntarPaginas(
  actuales: SolicitudResumen[],
  nuevas: SolicitudResumen[],
): SolicitudResumen[] {
  const vistos = new Set(actuales.map((s) => s.id));
  return [...actuales, ...nuevas.filter((s) => !vistos.has(s.id))];
}

/**
 * Una clave para UN intento de una acción. Se reusa mientras sea el mismo
 * intento (un reintento tras perder la conexión), y se cambia en el siguiente.
 */
let intentos = 0;
export function nuevaClave(): string {
  intentos += 1;
  return `srv-${Date.now().toString(36)}-${intentos}-${Math.random().toString(36).slice(2, 10)}`;
}

// --------------------------------------------------------------------------- //
// Condiciones del prestador (administración)
// --------------------------------------------------------------------------- //
export type Repostulacion = 'sinDecidir' | 'allowed' | 'not_allowed';
export const REPOSTULACIONES: Repostulacion[] = ['sinDecidir', 'allowed', 'not_allowed'];

/**
 * El borrador de las condiciones y sus PARÁMETROS. Cada parámetro es una
 * decisión de la empresa que se toma aquí, a la vista, y viaja SOLO si se
 * tomó: «sin decidir» no manda nada, y el servidor contesta entonces
 * `service_reapplication_not_configured` en vez de suponer.
 */
export type FormularioDeCondiciones = {
  pais: string;
  titulo: string;
  texto: string;
  repostulacion: Repostulacion;
  documentosPersona: string[];
  documentosEmpresa: string[];
  credenciales: string[];
};

export function condicionesVacias(): FormularioDeCondiciones {
  return {
    pais: '',
    titulo: '',
    texto: '',
    repostulacion: 'sinDecidir',
    documentosPersona: [],
    documentosEmpresa: [],
    credenciales: [],
  };
}

function listaDeTextos(valor: unknown): string[] {
  return Array.isArray(valor) ? valor.filter((x): x is string => typeof x === 'string') : [];
}

export function condicionesDesde(p: Politica): FormularioDeCondiciones {
  const parametros = (p.parameters ?? {}) as Record<string, unknown>;
  const documentos = (parametros.required_documents ?? {}) as Record<string, unknown>;
  const repostular = parametros.reapplication_after_rejection;
  return {
    pais: p.country_code,
    titulo: p.title,
    texto: p.body,
    repostulacion: repostular === 'allowed' || repostular === 'not_allowed' ? repostular : 'sinDecidir',
    documentosPersona: listaDeTextos(documentos.individual),
    documentosEmpresa: listaDeTextos(documentos.company),
    credenciales: listaDeTextos(parametros.required_credentials),
  };
}

export function parametrosDeCondiciones(f: FormularioDeCondiciones): Record<string, unknown> {
  const parametros: Record<string, unknown> = {};
  const documentos: Record<string, string[]> = {};
  const validos = (lista: string[], cerrada: readonly string[]) =>
    [...new Set(lista)].filter((k) => cerrada.includes(k));
  const persona = validos(f.documentosPersona, TIPOS_DE_DOCUMENTO);
  const empresa = validos(f.documentosEmpresa, TIPOS_DE_DOCUMENTO);
  if (persona.length > 0) documentos.individual = persona;
  if (empresa.length > 0) documentos.company = empresa;
  if (Object.keys(documentos).length > 0) parametros.required_documents = documentos;
  const credenciales = validos(f.credenciales, TIPOS_DE_CREDENCIAL);
  if (credenciales.length > 0) parametros.required_credentials = credenciales;
  if (f.repostulacion !== 'sinDecidir') parametros.reapplication_after_rejection = f.repostulacion;
  return parametros;
}

export function peticionDeCondiciones(f: FormularioDeCondiciones): {
  peticion: { country_code: string; title: string; body: string; parameters: Record<string, unknown> } | null;
  fallos: Fallo[];
} {
  const fallos: Fallo[] = [];
  const pais = f.pais.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(pais)) fallos.push({ campo: 'pais', clave: 'servicios.validacion.pais' });
  const titulo = f.titulo.trim();
  if (titulo.length < 3) fallos.push({ campo: 'titulo', clave: 'servicios.validacion.corto' });
  else if (titulo.length > 200) fallos.push({ campo: 'titulo', clave: 'servicios.validacion.largo' });
  const texto = f.texto.trim();
  if (texto.length < 50) fallos.push({ campo: 'texto', clave: 'servicios.validacion.textoCorto' });
  else if (texto.length > 100_000) fallos.push({ campo: 'texto', clave: 'servicios.validacion.largo' });
  if (fallos.length > 0) return { peticion: null, fallos };
  return {
    peticion: { country_code: pais, title: titulo, body: texto, parameters: parametrosDeCondiciones(f) },
    fallos,
  };
}

/** Pone o quita un valor de una lista (para los chips de selección múltiple). */
export function alternar(lista: string[], valor: string): string[] {
  return lista.includes(valor) ? lista.filter((x) => x !== valor) : [...lista, valor];
}

export function claveDelEstadoDePolitica(estado: string): string {
  return ['draft', 'published', 'superseded', 'withdrawn'].includes(estado)
    ? `servicios.politica.estado.${estado}`
    : 'servicios.politica.estado.draft';
}

/** Una fecha del servidor como dd/mm/aaaa, en la hora del teléfono. Vacía si no vale. */
export function fechaCorta(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const dos = (n: number) => String(n).padStart(2, '0');
  return `${dos(d.getDate())}/${dos(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** El peso de un archivo, legible. */
export function pesoLegible(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** La huella, legible y corta: sirve para comparar a ojo, no para verificar. */
export function huellaCorta(sha256: string | null | undefined): string {
  return sha256 ? `${sha256.slice(0, 8)}…${sha256.slice(-4)}` : '';
}
