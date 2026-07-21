import { apiRequest, API_V1 } from '@/services/api';
import { CommentDto, PostDto, toComment, toPost } from '@/mappers/postMapper';
import { signMediaUrls, type UploadedMedia } from '@/services/storage';
import type { Comment, Post } from '@/types';

export type FeedPage = {
  items: Post[];
  likedIds: string[];
  savedIds: string[];
};

/** 'all' = pestaña "Para ti"; 'following' = pestaña "Siguiendo". */
export type FeedKind = 'all' | 'following';

/**
 * Firma el primer medio de cada post y lo asigna a item.mediaUrl/mediaType
 * (sirve para imagen, video y audio).
 */
async function attachMediaUrls(items: Post[], dtos: PostDto[]): Promise<void> {
  const paths = dtos
    .map((d) => d.media[0]?.storage_path)
    .filter((p): p is string => Boolean(p));
  if (paths.length === 0) return;
  const urls = await signMediaUrls(paths);
  dtos.forEach((dto, i) => {
    const first = dto.media[0];
    const item = items[i];
    if (first && item && urls[first.storage_path]) {
      item.mediaUrl = urls[first.storage_path];
      item.mediaType = first.media_type as Post['mediaType'];
    }
  });
}

/**
 * Acceso al feed y a las interacciones a traves del backend FastAPI.
 * La identidad (autor / quien da like) la resuelve el backend desde el JWT.
 */
export const PostRepository = {
  async listFeed(
    {
      limit = 20,
      offset = 0,
      feed = 'all',
    }: { limit?: number; offset?: number; feed?: FeedKind } = {},
    currentUserId?: string | null,
  ): Promise<FeedPage> {
    const dtos = await apiRequest<PostDto[]>(
      `${API_V1}/posts?limit=${limit}&offset=${offset}&feed=${feed}`,
    );
    const items = dtos.map((dto) => toPost(dto, currentUserId));
    await attachMediaUrls(items, dtos);
    return {
      items,
      likedIds: dtos.filter((d) => d.liked_by_me).map((d) => d.id),
      savedIds: dtos.filter((d) => d.saved_by_me).map((d) => d.id),
    };
  },

  async createPost(
    body: string,
    media: UploadedMedia[] = [],
    currentUserId?: string | null,
  ): Promise<Post> {
    const dto = await apiRequest<PostDto>(`${API_V1}/posts`, {
      method: 'POST',
      body: JSON.stringify({
        body,
        media: media.map((m) => ({
          storage_path: m.storagePath,
          media_type: m.mediaType,
        })),
      }),
    });
    const post = toPost(dto, currentUserId);
    await attachMediaUrls([post], [dto]);
    return post;
  },

  async deletePost(postId: string): Promise<void> {
    await apiRequest<void>(`${API_V1}/posts/${postId}`, { method: 'DELETE' });
  },

  async like(postId: string): Promise<number> {
    const res = await apiRequest<{ liked: boolean; likes_count: number }>(
      `${API_V1}/posts/${postId}/like`,
      { method: 'POST' },
    );
    return res.likes_count;
  },

  async unlike(postId: string): Promise<number> {
    const res = await apiRequest<{ liked: boolean; likes_count: number }>(
      `${API_V1}/posts/${postId}/like`,
      { method: 'DELETE' },
    );
    return res.likes_count;
  },

  async save(postId: string): Promise<void> {
    await apiRequest<{ saved: boolean }>(`${API_V1}/posts/${postId}/save`, {
      method: 'POST',
    });
  },

  async unsave(postId: string): Promise<void> {
    await apiRequest<{ saved: boolean }>(`${API_V1}/posts/${postId}/save`, {
      method: 'DELETE',
    });
  },

  async listComments(postId: string): Promise<Comment[]> {
    const dtos = await apiRequest<CommentDto[]>(
      `${API_V1}/posts/${postId}/comments`,
      { auth: false },
    );
    return dtos.map(toComment);
  },

  async addComment(postId: string, body: string): Promise<Comment> {
    const dto = await apiRequest<CommentDto>(`${API_V1}/posts/${postId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
    return toComment(dto);
  },
};
