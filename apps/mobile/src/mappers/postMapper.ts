import { profileImageUrl } from '@/services/storage';
import type { Comment, Post } from '@/types';

export type PostAuthorDto = {
  id: string;
  full_name: string;
  username: string | null;
  avatar_path: string | null;
};

export type PostMediaDto = {
  storage_path: string;
  media_type: string;
  sort_order: number;
  /*
    Metadata opcional del medio. La informa el backend cuando existe; un
    backend anterior a la migracion 0021 simplemente no manda estos campos y
    todo sigue funcionando con el original.
  */
  width?: number | null;
  height?: number | null;
  duration_s?: number | null;
  bytes?: number | null;
  /** Miniatura/poster generado (imagen), si existe. */
  poster_path?: string | null;
  /** Version optimizada para el feed (imagen recomprimida o MP4 ligero). */
  feed_path?: string | null;
  /** Raiz del empaquetado HLS, si el video fue transcodificado. */
  stream_path?: string | null;
  processing_status?: string | null;
};

export type PostDto = {
  id: string;
  author: PostAuthorDto;
  body: string;
  status: string;
  visibility: string;
  /** Categoría temática; alimenta los filtros del podcast. */
  category?: string | null;
  created_at: string;
  media: PostMediaDto[];
  likes_count: number;
  comments_count: number;
  liked_by_me: boolean;
  saved_by_me: boolean;
};

export type CommentDto = {
  id: string;
  post_id: string;
  author: PostAuthorDto;
  parent_id: string | null;
  body: string;
  created_at: string;
};

function authorName(author: PostAuthorDto): string {
  return author.full_name || author.username || 'Usuario';
}

function authorHandle(author: PostAuthorDto): string {
  if (author.username) return `@${author.username}`;
  const base = authorName(author).toLowerCase().replace(/[^a-z0-9_.]+/g, '').slice(0, 18);
  return `@${base || 'usuario'}`;
}

/** Fecha ISO -> texto corto para la tarjeta ("Ahora", "5m", "2h", "3d"). */
export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.floor((Date.now() - then) / 1000);
  if (secs < 60) return 'Ahora';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString();
}

export function toComment(dto: CommentDto): Comment {
  return {
    id: dto.id,
    author: authorName(dto.author),
    text: dto.body,
    createdAt: formatRelativeTime(dto.created_at),
  };
}

/**
 * PostDto del backend -> Post del modelo de vista. Los comentarios se cargan
 * bajo demanda; el contador viene en commentsCount.
 */
export function toPost(dto: PostDto, currentUserId?: string | null): Post {
  const first = dto.media[0];
  return {
    category: dto.category ?? null,
    id: dto.id,
    author: authorName(dto.author),
    authorId: dto.author.id,
    authorAvatarUrl: profileImageUrl(dto.author.avatar_path),
    username: authorHandle(dto.author),
    body: dto.body,
    createdAt: formatRelativeTime(dto.created_at),
    createdAtIso: dto.created_at,
    likes: dto.likes_count,
    comments: [],
    commentsCount: dto.comments_count,
    isOwn: currentUserId ? dto.author.id === currentUserId : undefined,
    // El tipo y la ruta van SIEMPRE, aunque la firma llegue despues (o falle):
    // con ellos la tarjeta ya sabe que hueco reservar y que cache consultar.
    mediaType: first ? (first.media_type as Post['mediaType']) : undefined,
    // Se prefiere la version optimizada para el feed; el original queda como
    // respaldo para el contenido anterior al pipeline de derivados.
    mediaPath: first ? (first.feed_path ?? first.storage_path) : undefined,
    posterPath: first?.poster_path ?? undefined,
    mediaWidth: first?.width ?? undefined,
    mediaHeight: first?.height ?? undefined,
    mediaDurationS: first?.duration_s ?? undefined,
    processingStatus: (first?.processing_status as Post['processingStatus']) ?? undefined,
  };
}
