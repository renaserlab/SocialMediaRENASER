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
    if (!first || !item) return;
    // El TIPO se asigna siempre: viene del backend y no depende de Storage.
    // Antes solo se ponia si la firma habia funcionado, y como firmar exige
    // sesion (el bucket es privado), un visitante anonimo recibia los posts
    // sin tipo y la galeria del perfil salia vacia.
    item.mediaType = first.media_type as Post['mediaType'];
    const signed = urls[first.storage_path];
    if (signed) item.mediaUrl = signed;
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
    // Los audios se dejan fuera del muro: son episodios del podcast y tienen
    // su propia sección en el perfil del administrador.
    const dtos = await apiRequest<PostDto[]>(
      `${API_V1}/posts?limit=${limit}&offset=${offset}&feed=${feed}&exclude_media=audio`,
    );
    const items = dtos.map((dto) => toPost(dto, currentUserId));
    await attachMediaUrls(items, dtos);
    return {
      items,
      likedIds: dtos.filter((d) => d.liked_by_me).map((d) => d.id),
      savedIds: dtos.filter((d) => d.saved_by_me).map((d) => d.id),
    };
  },

  /**
   * Publicaciones de un perfil, para su galeria.
   * `media` separa la cuadricula (image/video) de la lista de audios.
   */
  async listByAuthor(
    authorId: string,
    { media, limit = 30 }: { media?: 'image' | 'video' | 'audio'; limit?: number } = {},
    currentUserId?: string | null,
  ): Promise<Post[]> {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: '0',
      author_id: authorId,
    });
    if (media) params.set('media', media);
    const dtos = await apiRequest<PostDto[]>(`${API_V1}/posts?${params.toString()}`);
    const items = dtos.map((dto) => toPost(dto, currentUserId));
    await attachMediaUrls(items, dtos);
    return items;
  },

  /** Publicaciones con video, en orden reciente: alimentan los reels. */
  async listVideos(currentUserId?: string | null): Promise<Post[]> {
    const dtos = await apiRequest<PostDto[]>(
      `${API_V1}/posts?limit=30&offset=0&media=video`,
    );
    const items = dtos.map((dto) => toPost(dto, currentUserId));
    await attachMediaUrls(items, dtos);
    return items;
  },

  /** Publicaciones de un círculo. */
  async listByCircle(circleId: string, currentUserId?: string | null): Promise<Post[]> {
    const dtos = await apiRequest<PostDto[]>(
      `${API_V1}/posts?limit=30&offset=0&circle_id=${encodeURIComponent(circleId)}`,
    );
    const items = dtos.map((dto) => toPost(dto, currentUserId));
    await attachMediaUrls(items, dtos);
    return items;
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

  /**
   * Edita una publicación propia. `media` sin definir deja el adjunto como
   * está; pasarlo (aunque sea vacío) lo reemplaza, lo que permite quitarlo.
   */
  async updatePost(
    postId: string,
    changes: { body?: string; media?: UploadedMedia[] },
    currentUserId?: string | null,
  ): Promise<Post> {
    const payload: Record<string, unknown> = {};
    if (changes.body !== undefined) payload.body = changes.body;
    if (changes.media !== undefined) {
      payload.media = changes.media.map((m) => ({
        storage_path: m.storagePath,
        media_type: m.mediaType,
      }));
    }
    const dto = await apiRequest<PostDto>(`${API_V1}/posts/${postId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
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
