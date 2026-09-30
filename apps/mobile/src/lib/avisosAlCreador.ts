/**
 * Los avisos al CREADOR: qué dicen y a dónde llevan.
 *
 * El servidor los escribe desde el 24/09/2026 (`notifications/decisiones.py`)
 * cuando se decide sobre lo que alguien creó: su evento, su curso, su
 * postulación de proveedor o su producto. Antes nadie se enteraba de nada,
 * aunque las pantallas prometían «te avisaremos».
 *
 * PURO Y SIN IMPORTS en tiempo de ejecución, para probarlo con `node --test`:
 * devuelve CLAVES de traducción y RUTAS; quien pinta traduce y navega.
 */

export type AvisoAlCreador = {
  /** Clave de `i18n` del título. */
  titulo: string;
  /** Icono de Feather. */
  icono:
    | 'check-circle'
    | 'x-circle'
    | 'alert-triangle'
    | 'edit-3'
    | 'eye-off'
    | 'image'
    | 'clock'
    | 'inbox'
    | 'calendar';
  /**
   * Clave del texto de debajo cuando el servidor NO manda título ni motivo.
   * Los avisos de Servicios van con `payload` vacío a propósito: el detalle se
   * lee en la postulación, no en la bandeja.
   */
  cuerpo?: string;
};

const AVISOS: Record<string, AvisoAlCreador> = {
  event_admission_approved: { titulo: 'notif.eventApprovedTitle', icono: 'check-circle' },
  event_admission_conditional: { titulo: 'notif.eventConditionalTitle', icono: 'alert-triangle' },
  event_admission_rejected: { titulo: 'notif.eventRejectedTitle', icono: 'x-circle' },
  event_admission_changes: { titulo: 'notif.eventChangesTitle', icono: 'edit-3' },
  event_published: { titulo: 'notif.eventPublishedTitle', icono: 'check-circle' },
  event_suspended: { titulo: 'notif.eventSuspendedTitle', icono: 'eye-off' },
  course_review_approved: { titulo: 'notif.courseApprovedTitle', icono: 'check-circle' },
  course_review_rejected: { titulo: 'notif.courseRejectedTitle', icono: 'x-circle' },
  course_published: { titulo: 'notif.coursePublishedTitle', icono: 'check-circle' },
  seller_application_accepted: { titulo: 'notif.sellerAcceptedTitle', icono: 'check-circle' },
  seller_application_rejected: { titulo: 'notif.sellerRejectedTitle', icono: 'x-circle' },
  product_published: { titulo: 'notif.productPublishedTitle', icono: 'check-circle' },
  product_suspended: { titulo: 'notif.productSuspendedTitle', icono: 'eye-off' },
  product_photo_rejected: { titulo: 'notif.productPhotoRejectedTitle', icono: 'image' },
  // Z Servicios (`services/avisos.py`). A quien postula:
  service_application_review_started: { titulo: 'notif.servicioRevisionTitle', icono: 'clock', cuerpo: 'notif.servicioRevisionBody' },
  service_application_changes_requested: { titulo: 'notif.servicioCambiosTitle', icono: 'edit-3', cuerpo: 'notif.servicioCambiosBody' },
  service_application_approved: { titulo: 'notif.servicioAprobadaTitle', icono: 'check-circle', cuerpo: 'notif.servicioAprobadaBody' },
  service_application_rejected: { titulo: 'notif.servicioRechazadaTitle', icono: 'x-circle', cuerpo: 'notif.servicioRechazadaBody' },
  service_application_suspended: { titulo: 'notif.servicioSuspendidaTitle', icono: 'eye-off', cuerpo: 'notif.servicioSuspendidaBody' },
  service_application_withdrawn: { titulo: 'notif.servicioRetiradaTitle', icono: 'check-circle', cuerpo: 'notif.servicioRetiradaBody' },
  service_document_observed: { titulo: 'notif.servicioDocumentoTitle', icono: 'alert-triangle', cuerpo: 'notif.servicioDocumentoBody' },
  service_credential_observed: { titulo: 'notif.servicioCredencialObservadaTitle', icono: 'alert-triangle', cuerpo: 'notif.servicioCredencialObservadaBody' },
  service_credential_rejected: { titulo: 'notif.servicioCredencialRechazadaTitle', icono: 'x-circle', cuerpo: 'notif.servicioCredencialRechazadaBody' },
  // Al equipo de Z:
  service_application_submitted: { titulo: 'notif.servicioEnviadaTitle', icono: 'inbox', cuerpo: 'notif.servicioEnviadaBody' },
  service_application_resubmitted: { titulo: 'notif.servicioReenviadaTitle', icono: 'inbox', cuerpo: 'notif.servicioReenviadaBody' },
  service_application_withdrawn_review: { titulo: 'notif.servicioRetiradaEquipoTitle', icono: 'inbox', cuerpo: 'notif.servicioRetiradaEquipoBody' },
  // El catálogo de Servicios (Incremento 2). A quien ofrece el servicio:
  service_catalog_review_started: { titulo: 'notif.servicioCatalogoRevisionTitle', icono: 'clock', cuerpo: 'notif.servicioCatalogoRevisionBody' },
  service_catalog_changes_requested: { titulo: 'notif.servicioCatalogoCambiosTitle', icono: 'edit-3', cuerpo: 'notif.servicioCatalogoCambiosBody' },
  service_catalog_approved: { titulo: 'notif.servicioCatalogoAprobadoTitle', icono: 'check-circle', cuerpo: 'notif.servicioCatalogoAprobadoBody' },
  service_catalog_published: { titulo: 'notif.servicioCatalogoPublicadoTitle', icono: 'check-circle', cuerpo: 'notif.servicioCatalogoPublicadoBody' },
  service_catalog_suspended: { titulo: 'notif.servicioCatalogoSuspendidoTitle', icono: 'eye-off', cuerpo: 'notif.servicioCatalogoSuspendidoBody' },
  service_catalog_reinstated: { titulo: 'notif.servicioCatalogoReactivadoTitle', icono: 'check-circle', cuerpo: 'notif.servicioCatalogoReactivadoBody' },
  service_catalog_retired: { titulo: 'notif.servicioCatalogoRetiradoTitle', icono: 'x-circle', cuerpo: 'notif.servicioCatalogoRetiradoBody' },
  service_catalog_published_suspended: { titulo: 'notif.servicioCatalogoPublicadoSuspendidoTitle', icono: 'eye-off', cuerpo: 'notif.servicioCatalogoPublicadoSuspendidoBody' },
  // Y al equipo de Z:
  service_catalog_submitted: { titulo: 'notif.servicioCatalogoEnviadoTitle', icono: 'inbox', cuerpo: 'notif.servicioCatalogoEnviadoBody' },
  service_catalog_resubmitted: { titulo: 'notif.servicioCatalogoReenviadoTitle', icono: 'inbox', cuerpo: 'notif.servicioCatalogoReenviadoBody' },
  service_catalog_withdrawn_review: { titulo: 'notif.servicioCatalogoRetiradoEquipoTitle', icono: 'inbox', cuerpo: 'notif.servicioCatalogoRetiradoEquipoBody' },
  // La reserva (Incremento 5). A quien contrata, y al prestador. Sin fecha,
  // dirección ni nota: el detalle se lee en la reserva.
  service_booking_confirmed: { titulo: 'notif.servicioReservaConfirmadaTitle', icono: 'calendar', cuerpo: 'notif.servicioReservaConfirmadaBody' },
  service_booking_received: { titulo: 'notif.servicioReservaRecibidaTitle', icono: 'calendar', cuerpo: 'notif.servicioReservaRecibidaBody' },
};

/** El título y el icono de un aviso al creador, o `null` si no lo es. */
export function avisoAlCreador(tipo: string): AvisoAlCreador | null {
  return AVISOS[tipo] ?? null;
}

/**
 * El texto de debajo: el nombre de lo que se decidió y, si lo hay, el motivo.
 *
 * El motivo es lo que le dice a quien creó qué corregir; sin él, un «no fue
 * aprobado» es un muro. Nunca llegan notas internas: el servidor solo manda
 * el motivo público.
 */
export function detalleDelAviso(payload: { title?: unknown; reason?: unknown } | null | undefined): string {
  const titulo = typeof payload?.title === 'string' ? payload.title.trim() : '';
  const motivo = typeof payload?.reason === 'string' ? payload.reason.trim() : '';
  if (titulo && motivo) return `«${titulo}»: ${motivo}`;
  if (titulo) return `«${titulo}»`;
  return motivo;
}

/**
 * A dónde lleva tocarlo: donde se ve o se corrige lo que anuncia.
 *
 * - Lo publicado, a su ficha pública: es lo que la persona quiere ver.
 * - Lo que hay que corregir (rechazos, cambios, suspensiones, fotos), a su
 *   editor, que es donde se arregla.
 * - La postulación aceptada, a «Mis productos», donde ya se puede crear; la
 *   rechazada, a la postulación.
 */
export function rutaDelAviso(
  tipo: string,
  entidadId: string | null | undefined,
): string | null {
  const id = (entidadId ?? '').trim();
  switch (tipo) {
    case 'event_published':
      return id ? `/eventos/${id}` : '/mis-eventos';
    case 'event_admission_approved':
    case 'event_admission_conditional':
    case 'event_admission_rejected':
    case 'event_admission_changes':
    case 'event_suspended':
      return id ? `/editar-evento/${id}` : '/mis-eventos';
    case 'course_published':
      return id ? `/course/${id}` : null;
    case 'course_review_approved':
    case 'course_review_rejected':
      return id ? `/editar-curso/${id}` : null;
    case 'seller_application_accepted':
      return '/proveedor/productos';
    case 'seller_application_rejected':
      return '/proveedor/postular';
    case 'product_published':
      return id ? `/productos/${id}` : '/proveedor/productos';
    case 'product_suspended':
    case 'product_photo_rejected':
      return id ? `/proveedor/productos/${id}` : '/proveedor/productos';
    // Z Servicios: quien postula, a su postulación; el equipo, al expediente.
    case 'service_application_review_started':
    case 'service_application_changes_requested':
    case 'service_application_approved':
    case 'service_application_rejected':
    case 'service_application_suspended':
    case 'service_application_withdrawn':
    case 'service_document_observed':
    case 'service_credential_observed':
    case 'service_credential_rejected':
      return '/servicios/prestador';
    case 'service_application_submitted':
    case 'service_application_resubmitted':
    case 'service_application_withdrawn_review':
      return id ? `/admin/servicios/${id}` : '/admin/servicios';
    // El catálogo: lo publicado, a su ficha pública; lo demás, al servicio
    // propio, donde se lee el motivo y se corrige; el equipo, a la revisión.
    case 'service_catalog_published':
      return id ? `/servicios/ficha/${id}` : '/servicios/prestador/catalogo';
    case 'service_catalog_review_started':
    case 'service_catalog_changes_requested':
    case 'service_catalog_approved':
    case 'service_catalog_suspended':
    case 'service_catalog_reinstated':
    case 'service_catalog_retired':
    // Publicada en un servicio SUSPENDIDO: la ficha contestaría 404.
    case 'service_catalog_published_suspended':
      return id ? `/servicios/prestador/catalogo/${id}` : '/servicios/prestador/catalogo';
    case 'service_catalog_submitted':
    case 'service_catalog_resubmitted':
    case 'service_catalog_withdrawn_review':
      return id ? `/admin/servicios/catalogo/${id}` : '/admin/servicios/catalogo';
    // La reserva: quien contrata, a SU reserva; el prestador, a la de su bandeja.
    case 'service_booking_confirmed':
      return id ? `/servicios/reservas/${id}` : '/servicios/reservas';
    case 'service_booking_received':
      return id ? `/servicios/prestador/reservas/${id}` : '/servicios/prestador/reservas';
    // «Juan está transmitiendo en vivo»: al directo, siga o no en emisión.
    case 'live_started':
      return id ? `/live/${id}` : null;
    default:
      return null;
  }
}
