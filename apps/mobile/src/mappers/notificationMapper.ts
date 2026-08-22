import { formatRelativeTime } from '@/mappers/postMapper';

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
};

export type NotificationItem = {
  id: string;
  title: string;
  subtitle: string;
  icon: 'bell' | 'award' | 'message-square' | 'calendar';
  time: string;
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
};

export function toNotificationItem(dto: NotificationDto): NotificationItem {
  const actor = dto.actor?.full_name ?? 'Alguien';
  let title = 'Notificación';
  let subtitle = actor;
  let icon: NotificationItem['icon'] = 'bell';

  switch (dto.type) {
    case 'follow':
      title = 'Nuevo seguidor';
      subtitle = `${actor} te empezó a seguir`;
      icon = 'bell';
      break;
    case 'like':
      title = 'Nuevo me gusta';
      subtitle = `A ${actor} le gustó tu publicación`;
      icon = 'award';
      break;
    case 'comment':
      title = 'Nuevo comentario';
      subtitle = `${actor} comentó tu publicación`;
      icon = 'message-square';
      break;
    /*
      La agenda. Un tipo por respuesta y no uno solo: «Sesión confirmada» y
      «Solicitud rechazada» tienen que distinguirse en la lista sin abrir nada.
      Antes todos caían al genérico y salían como «Notificación».
    */
    case 'session_booked':
      title = 'Nueva solicitud de sesión';
      subtitle = `${actor} quiere agendar contigo`;
      icon = 'calendar';
      break;
    case 'session_accepted':
      title = 'Sesión confirmada';
      subtitle = `${actor} aceptó tu solicitud`;
      icon = 'calendar';
      break;
    case 'session_rejected':
      title = 'Solicitud rechazada';
      subtitle = `${actor} no puede en esta ocasión`;
      icon = 'calendar';
      break;
    case 'session_cancelled':
      title = 'Sesión cancelada';
      subtitle = `${actor} canceló la sesión`;
      icon = 'calendar';
      break;
    case 'session_rescheduled':
      title = 'Nueva fecha propuesta';
      subtitle = `${actor} propone otra fecha`;
      icon = 'calendar';
      break;
    case 'session_completed':
      title = 'Sesión realizada';
      subtitle = `${actor} dio la sesión por hecha`;
      icon = 'calendar';
      break;
  }

  return {
    id: dto.id,
    title,
    subtitle,
    icon,
    time: formatRelativeTime(dto.created_at),
    read: dto.read,
    actorId: dto.actor?.id,
    entityType: dto.entity_type,
    entityId: dto.entity_id,
  };
}
