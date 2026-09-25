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
  icono: 'check-circle' | 'x-circle' | 'alert-triangle' | 'edit-3' | 'eye-off' | 'image';
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
    default:
      return null;
  }
}
