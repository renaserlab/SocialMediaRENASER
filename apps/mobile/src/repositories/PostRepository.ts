import { apiRequest, API_V1 } from '@/services/api';
import { CommentDto, PostDto, toComment, toPost } from '@/mappers/postMapper';
import { signImageUrls } from '@/services/storage';
import type { Comment, Post } from '@/types';

export type FeedPage = {
  items: Post[];
  likedIds: string[];
  savedIds: string[];
};

/** Firma la primera imagen de cada post y la asigna a item.imageUrl. */
async function attachImageUrls(items: Post[], dtos: PostDto[]): Promise<void> {
  const paths = dtos
    .map((d) => d.media[0]?.storage_path)
    .filter((p): p is string => Boolean(p));
  if (paths.length === 0) return;
  const urls = await signImageUrls(paths);
  dtos.forEach((dto, i) => {
    const path = dto.media[0]?.storage_path;
    const item = items[i];
    if (path && item && urls[path]) item.imageUrl = urls[path];
  });
}

/**
 * Acceso al feed y a las interacciones a traves del backend FastAPI.
 * La identidad (autor / quien da like) la resuelve el backend desde el JWT.
 */
export const PostRepository = {
  async listFeed(
    { limit = 20, offset = 0 }: { limit?: number; offset?: number } = {},
    currentUserId?: string | null,
  ): Promise<FeedPage> {
    const dtos = await apiRequest<PostDto[]>(
      `${API_V1}/posts?limit=${limit}&offset=${offset}`,
    );
    const items = dtos.map((dto) => toPost(dto, currentUserId));
    await attachImageUrls(items, dtos);
    return {
      items,
      likedIds: dtos.filter((d) => d.liked_by_me).map((d) => d.id),
      savedIds: dtos.filter((d) => d.saved_by_me).map((d) => d.id),
    };
  },

  async createPost(
    body: string,
    imagePaths: string[] = [],
    currentUserId?: string | null,
  ): Promise<Post> {
    const dto = await apiRequest<PostDto>(`${API_V1}/posts`, {
      method: 'POST',
      body: JSON.stringify({ body, image_paths: imagePaths }),
    });
    const post = toPost(dto, currentUserId);
    await attachImageUrls([post], [dto]);
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
