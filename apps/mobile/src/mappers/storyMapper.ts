import type { StoryGroup, StoryItem, StoryViewer } from '@/types';

import type { PostAuthorDto } from '@/mappers/postMapper';

export type StoryDto = {
  id: string;
  storage_path: string;
  media_type: 'image' | 'video';
  duration_ms: number;
  caption: string;
  created_at: string;
  expires_at: string;
  viewed_by_me: boolean;
  views_count: number;
};

export type StoryGroupDto = {
  author: PostAuthorDto;
  items: StoryDto[];
  seen: boolean;
  is_own: boolean;
};

export type StoryViewerDto = {
  viewer: PostAuthorDto;
  viewed_at: string;
};

function authorName(author: PostAuthorDto): string {
  return author.full_name || author.username || 'Usuario';
}

function authorHandle(author: PostAuthorDto): string {
  if (author.username) return `@${author.username}`;
  const base = authorName(author).toLowerCase().replace(/[^a-z0-9_.]+/g, '').slice(0, 18);
  return `@${base || 'usuario'}`;
}

export function toStoryItem(dto: StoryDto): StoryItem {
  return {
    id: dto.id,
    storagePath: dto.storage_path,
    mediaType: dto.media_type,
    durationMs: dto.duration_ms,
    caption: dto.caption,
    createdAt: dto.created_at,
    viewedByMe: dto.viewed_by_me,
    viewsCount: dto.views_count,
  };
}

export function toStoryGroup(dto: StoryGroupDto): StoryGroup {
  return {
    authorId: dto.author.id,
    author: authorName(dto.author),
    username: authorHandle(dto.author),
    avatarPath: dto.author.avatar_path ?? undefined,
    items: dto.items.map(toStoryItem),
    seen: dto.seen,
    isOwn: dto.is_own,
  };
}

export function toStoryViewer(dto: StoryViewerDto): StoryViewer {
  return {
    id: dto.viewer.id,
    fullName: authorName(dto.viewer),
    username: authorHandle(dto.viewer),
    viewedAt: dto.viewed_at,
  };
}
