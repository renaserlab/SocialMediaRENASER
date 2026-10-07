import { traduceEnElIdiomaActual } from '@/i18n';
import { formatRelativeTime } from '@/mappers/postMapper';
import { textoDeReacciones } from '@/lib/reacciones';
import { avisoAlCreador, detalleDelAviso } from '@/lib/avisosAlCreador';
import type { TranslationKey } from '@/i18n';

export type NotificationActorDto = {
  id: string;
  full_name: string;
  username: string | null;
  avatar_path: string | null;
};

export type NotificationDto = {
  id: string;
  type: string;
  actor: NotificationActorDto | null;
  entity_type: string | null;
  entity_id: string | null;
  read: boolean;
  created_at: string;
  /**
   * Cuánta gente reaccionó en total. Solo viene en los avisos agrupados de
   * «me gusta»; `null`/ausente en todo lo demás.
   */
  group_count?: number | null;
  /**
   * Lo que el aviso necesita ademas de su entidad. Hoy solo `comment_like`, que
   * guarda el COMENTARIO en `entity_id` —para no deduplicar de mas— y trae aqui
   * la publicacion, que es a donde lleva al tocarlo.
   */
  /** `postId` en los comentarios; `title`/`reason`/`automatic` en los avisos al creador. */
  payload?: { postId?: string; title?: string; reason?: string; automatic?: boolean } | null;
};

export type NotificationItem = {
  id: string;
  title: string;
  subtitle: string;
  icon:
    | 'bell'
    | 'award'
    | 'message-square'
    | 'calendar'
    | 'at-sign'
    | 'check-circle'
    | 'x-circle'
    | 'alert-triangle'
    | 'edit-3'
    | 'eye-off'
    | 'image'
    | 'radio'
    | 'clock'
    | 'inbox';
  time: string;
  /** Cuándo se creó, tal como lo dice el servidor: para saber si es nuevo. */
  createdAtIso?: string;
  read: boolean;
  actorId?: string;
  /**
   * A qué se refiere el aviso, cuando se refiere a algo.
   *
   * Sin esto, TODOS los avisos llevaban al perfil de quien los provocó: tocar
   * «Sesión confirmada» abría un perfil en vez de la agenda donde está la
   * sesión.
   */
  entityType?: string | null;
  entityId?: string | null;
  /** A que publicacion lleva, cuando `entityId` no es ella. */
  postId?: string | null;
  /** El `type` del servidor: decide a dónde lleva tocarlo. */
  type?: string;
};

export function toNotificationItem(dto: NotificationDto): NotificationItem {
  /*
    El texto se arma con `traduceEnElIdiomaActual` y no con `useTranslation`
    porque esto no es un componente. Cada frase que lleva el nombre de alguien
    va en UNA clave con hueco `{actor}`: partida en trozos no se puede recolocar
    en un idioma que ordene las palabras de otra forma.
  */
  const t = traduceEnElIdiomaActual;
  const actor = dto.actor?.full_name ?? t('notif.someone');
  let title = t('notif.generic');
  let subtitle = actor;
  let icon: NotificationItem['icon'] = 'bell';

  switch (dto.type) {
    case 'follow':
      title = t('notif.followTitle');
      subtitle = t('notif.followBody', { actor });
      icon = 'bell';
      break;
    case 'like':
      title = t('notif.likeTitle');
      subtitle = textoDeReacciones(actor, dto.group_count, {
        una: t('notif.likeOne'),
        unaMas: t('notif.likeTwo'),
        variasMas: t('notif.likeMany'),
      });
      icon = 'award';
      break;
    case 'comment':
      title = t('notif.commentTitle');
      subtitle = t('notif.commentBody', { actor });
      icon = 'message-square';
      break;
    /*
      Responder a un comentario. Tipo propio y no `comment`: a quien le
      responden no le comentaron la publicacion, y con el texto de aquel el
      aviso parecia ser de otra cosa. Mismo icono a proposito: las dos cosas
      llevan al mismo sitio y son la misma familia.
    */
    case 'comment_reply':
      title = t('notif.replyTitle');
      subtitle = t('notif.replyBody', { actor });
      icon = 'message-square';
      break;
    /*
      Un corazon a un COMENTARIO tuyo. Icono de reaccion, como el «me gusta» de
      una publicacion, porque es la misma accion sobre otra cosa; el texto es
      el que dice sobre que.
    */
    case 'comment_like':
      title = t('notif.commentLikeTitle');
      subtitle = t('notif.commentLikeBody', { actor });
      icon = 'award';
      break;
    /*
      Te etiquetaron (migración 0032). Icono propio: en una lista larga, lo
      primero que se distingue es la forma, y compartir el de «me gusta» haría
      que las dos cosas parecieran la misma de un vistazo.

      Al tocarlo abre /post/{id}, no el perfil de quien etiquetó: la publicación
      es donde está la etiqueta, y el perfil es justo donde no está. Eso lo
      resuelve `entityType === 'post'` en NotificationsScreen.
    */
    case 'post_mention':
      title = t('notif.mentionTitle');
      subtitle = t('notif.mentionBody', { actor });
      icon = 'at-sign';
      break;
    /*
      La agenda. Un tipo por respuesta y no uno solo: «Sesión confirmada» y
      «Solicitud rechazada» tienen que distinguirse en la lista sin abrir nada.
      Antes todos caían al genérico y salían como «Notificación».
    */
    case 'session_booked':
      title = t('notif.sessionBookedTitle');
      subtitle = t('notif.sessionBookedBody', { actor });
      icon = 'calendar';
      break;
    case 'session_accepted':
      title = t('notif.sessionAcceptedTitle');
      subtitle = t('notif.sessionAcceptedBody', { actor });
      icon = 'calendar';
      break;
    case 'session_rejected':
      title = t('notif.sessionRejectedTitle');
      subtitle = t('notif.sessionRejectedBody', { actor });
      icon = 'calendar';
      break;
    case 'session_cancelled':
      title = t('notif.sessionCancelledTitle');
      subtitle = t('notif.sessionCancelledBody', { actor });
      icon = 'calendar';
      break;
    case 'session_rescheduled':
      title = t('notif.sessionRescheduledTitle');
      subtitle = t('notif.sessionRescheduledBody', { actor });
      icon = 'calendar';
      break;
    case 'session_completed':
      title = t('notif.sessionCompletedTitle');
      subtitle = t('notif.sessionCompletedBody', { actor });
      icon = 'calendar';
      break;
    /*
      Alguien a quien sigues empezó un directo (desde el 25/09/2026, como en
      TikTok). Queda en la bandeja aunque el directo ya haya terminado: al
      tocarlo se abre la emisión, y si terminó, su pantalla lo dice.
    */
    case 'live_started':
      title = t('notif.liveTitle');
      subtitle = t('notif.liveBody', { actor });
      icon = 'radio';
      break;
    /*
      Quien emite te invita a salir con tu cámara (07/10/2026). Tocarlo abre el
      directo, y allí está la invitación si sigue en pie. Si ya no —terminó, o
      la retiraron—, la sala lo dice: el aviso no promete que siga abierta.
    */
    case 'live_invited':
      title = t('notif.liveInviteTitle');
      subtitle = t('notif.liveInviteBody', { actor });
      icon = 'radio';
      break;
    /*
      Compras y devoluciones. El servidor ya escribía estos avisos en la
      bandeja, pero aquí no tenían texto y salían con el genérico «Tienes una
      notificación», que no dice qué ha pasado.
    */
    case 'course_purchase':
      title = t('notif.coursePurchaseTitle');
      subtitle = t('notif.coursePurchaseBody', { actor });
      icon = 'award';
      break;
    case 'refund_requested':
      title = t('notif.refundRequestedTitle');
      subtitle = t('notif.refundRequestedBody');
      icon = 'clock';
      break;
    case 'refund_approved':
      title = t('notif.refundApprovedTitle');
      subtitle = t('notif.refundApprovedBody');
      icon = 'check-circle';
      break;
    case 'refund_rejected':
      title = t('notif.refundRejectedTitle');
      subtitle = t('notif.refundRejectedBody');
      icon = 'x-circle';
      break;
    case 'refund_refunded':
      title = t('notif.refundRefundedTitle');
      subtitle = t('notif.refundRefundedBody');
      icon = 'check-circle';
      break;
    default: {
      /*
        AVISOS AL CREADOR (desde el 24/09/2026): su evento, curso, postulación
        o producto. Sin actor —decide la plataforma—, así que el texto no es
        «Alguien…» sino el nombre de lo decidido y, si lo hay, el motivo.
      */
      const aviso = avisoAlCreador(dto.type);
      if (aviso !== null) {
        title = t(aviso.titulo as TranslationKey);
        subtitle =
          detalleDelAviso(dto.payload) ||
          (aviso.cuerpo ? t(aviso.cuerpo as TranslationKey) : title);
        icon = aviso.icono;
      }
    }
  }

  return {
    id: dto.id,
    title,
    subtitle,
    icon,
    time: formatRelativeTime(dto.created_at),
    createdAtIso: dto.created_at,
    read: dto.read,
    actorId: dto.actor?.id,
    entityType: dto.entity_type,
    entityId: dto.entity_id,
    postId: dto.payload?.postId ?? null,
    type: dto.type,
  };
}
