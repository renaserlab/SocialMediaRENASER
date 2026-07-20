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
};

export type PostDto = {
  id: string;
  author: PostAuthorDto;
  body: string;
  status: string;
  visibility: string;
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
  return {
    id: dto.id,
    author: authorName(dto.author),
    username: authorHandle(dto.author),
    body: dto.body,
    createdAt: formatRelativeTime(dto.created_at),
    likes: dto.likes_count,
    comments: [],
    commentsCount: dto.comments_count,
    isOwn: currentUserId ? dto.author.id === currentUserId : undefined,
  };
}
