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
  icon: 'bell' | 'award' | 'message-square';
  time: string;
  read: boolean;
  actorId?: string;
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
  }

  return {
    id: dto.id,
    title,
    subtitle,
    icon,
    time: formatRelativeTime(dto.created_at),
    read: dto.read,
    actorId: dto.actor?.id,
  };
}
