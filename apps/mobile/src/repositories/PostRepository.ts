import { apiRequest, API_V1 } from '@/services/api';
import { CommentDto, PostDto, toComment, toPost } from '@/mappers/postMapper';
import { signMediaUrls, type UploadedMedia } from '@/services/storage';
import { PRIVATE_AUDIO_CATEGORY } from '@/data/categories';
import type { Comment, Post } from '@/types';
import { toProfileSummary, type ProfileSummary, type ProfileSummaryDto } from '@/mappers/profileMapper';

export type FeedPage = {
  items: Post[];
  likedIds: string[];
  savedIds: string[];
};

/** 'all' = pestaña "Para ti"; 'following' = pestaña "Siguiendo". */
export type FeedKind = 'all' | 'following';

/**
 * Firma las URLs del medio y del poster de cada post y devuelve copias con
 * `mediaUrl`/`posterUrl` puestos. El tipo y las rutas ya vienen del mapper,
 * que no depende de Storage: un visitante anonimo (que no puede firmar audio)
 * conserva el tipo y la galeria no sale vacia.
 *
 * Es la SEGUNDA fase de la carga: la primera pinta el texto y reserva los
 * huecos con la metadata; esta rellena las imagenes. Con la cache de firmas
 * persistente suele resolverse sin tocar la red.
 */
export async function resolveMediaUrls(items: Post[]): Promise<Post[]> {
  const paths = new Set<string>();
  for (const item of items) {
    if (item.mediaPath) paths.add(item.mediaPath);
    if (item.posterPath) paths.add(item.posterPath);
  }
  if (paths.size === 0) return items;
  const urls = await signMediaUrls([...paths]);
  return items.map((item) => {
    const mediaUrl = item.mediaPath ? urls[item.mediaPath] : undefined;
    const posterUrl = item.posterPath ? urls[item.posterPath] : undefined;
    if (!mediaUrl && !posterUrl) return item;
    return {
      ...item,
      mediaUrl: mediaUrl ?? item.mediaUrl,
      posterUrl: posterUrl ?? item.posterUrl,
    };
  });
}

/** Variante mutante para los flujos de una sola fase (detalle, galerias). */
async function attachMediaUrls(items: Post[], _dtos?: PostDto[]): Promise<void> {
  const resolved = await resolveMediaUrls(items);
  resolved.forEach((post, i) => {
    const item = items[i];
    if (!item) return;
    item.mediaUrl = post.mediaUrl;
    item.posterUrl = post.posterUrl;
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
      withMediaUrls = true,
      timeoutMs,
    }: {
      limit?: number;
      offset?: number;
      feed?: FeedKind;
      /**
       * false = devolver los posts en cuanto llega el JSON, sin esperar a las
       * firmas de Storage. Quien llama pinta la metadata al momento y despues
       * completa las URLs con `resolveMediaUrls` (carga en dos fases).
       */
      withMediaUrls?: boolean;
      /** Espera mayor que la estandar, para sobrevivir al arranque de Render. */
      timeoutMs?: number;
    } = {},
    currentUserId?: string | null,
  ): Promise<FeedPage> {
    // Los audios se dejan fuera del muro: son episodios del podcast y tienen
    // su propia sección en el perfil del administrador.
    const dtos = await apiRequest<PostDto[]>(
      `${API_V1}/posts?limit=${limit}&offset=${offset}&feed=${feed}&exclude_media=audio`,
      timeoutMs ? { timeoutMs } : undefined,
    );
    const items = dtos.map((dto) => toPost(dto, currentUserId));
    if (withMediaUrls) await attachMediaUrls(items);
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
    {
      media,
      limit = 30,
      category,
      excludeCategory,
    }: {
      media?: 'image' | 'video' | 'audio';
      limit?: number;
      category?: string;
      excludeCategory?: string;
    } = {},
    currentUserId?: string | null,
  ): Promise<Post[]> {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: '0',
      author_id: authorId,
    });
    if (media) params.set('media', media);
    if (category) params.set('category', category);
    if (excludeCategory) params.set('exclude_category', excludeCategory);
    const dtos = await apiRequest<PostDto[]>(`${API_V1}/posts?${params.toString()}`);
    const items = dtos.map((dto) => toPost(dto, currentUserId));
    await attachMediaUrls(items, dtos);
    return items;
  },

  /**
   * El audio privado vigente: el más reciente que el administrador haya
   * marcado con la categoría reservada. `null` si aún no hay ninguno.
   */
  async getPrivateAudio(adminId: string, currentUserId?: string | null): Promise<Post | null> {
    const list = await this.listByAuthor(
      adminId,
      { media: 'audio', limit: 1, category: PRIVATE_AUDIO_CATEGORY },
      currentUserId,
    );
    return list[0] ?? null;
  },

  /**
   * Una publicacion concreta, pedida al servidor por su identificador.
   *
   * Hace falta porque la pantalla de detalle solo miraba el feed que hubiera
   * en memoria. Al abrir un enlace compartido, al recargar la pagina en el
   * navegador o al llegar desde un aviso, ese feed aun no existe y la
   * publicacion —que esta perfectamente publicada— se anunciaba como
   * «no disponible, es posible que se haya eliminado».
   */
  async getById(postId: string, currentUserId?: string | null): Promise<Post> {
    const dto = await apiRequest<PostDto>(`${API_V1}/posts/${encodeURIComponent(postId)}`);
    const item = toPost(dto, currentUserId);
    await attachMediaUrls([item], [dto]);
    return item;
  },

  /**
   * Publicaciones con video, en orden reciente: alimentan los reels.
   *
   * Paginado de verdad: antes pedia 30 videos con sus firmas para ensenar el
   * primero. Ahora se piden pocos y el siguiente lote se trae al acercarse al
   * final. Se mandan `offset` Y cursor a la vez: un backend anterior a la
   * paginacion por cursor ignora los parametros que no conoce y usa el offset,
   * asi que la misma app funciona contra ambas versiones.
   */
  /**
   * Quien reacciono a una publicacion, de lo mas reciente a lo mas antiguo.
   *
   * Es lo que abre la notificacion agrupada: sin esta lista, «Edson y 99
   * personas mas» no lleva a ningun sitio. Devuelve la misma forma que
   * seguidores y seguidos para poder reutilizar `PeopleList` en vez de
   * inventarse otra pantalla de gente.
   */
  async listLikes(postId: string): Promise<ProfileSummary[]> {
    const dtos = await apiRequest<ProfileSummaryDto[]>(
      `${API_V1}/posts/${postId}/likes?limit=50`,
    );
    return dtos.map(toProfileSummary);
  },

  async listVideos(
    currentUserId?: string | null,
    {
      limit = 6,
      offset = 0,
      feed = 'all',
      beforeCreatedAt,
      beforeId,
    }: {
      limit?: number;
      offset?: number;
      /** 'all' = "Para ti"; 'following' = solo de quien se sigue. */
      feed?: FeedKind;
      beforeCreatedAt?: string;
      beforeId?: string;
    } = {},
  ): Promise<Post[]> {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      media: 'video',
      feed,
    });
    if (beforeCreatedAt) params.set('before_created_at', beforeCreatedAt);
    if (beforeId) params.set('before_id', beforeId);
    const dtos = await apiRequest<PostDto[]>(`${API_V1}/posts?${params.toString()}`);
    const items = dtos.map((dto) => toPost(dto, currentUserId));
    await attachMediaUrls(items);
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
    category?: string | null,
    /**
     * De que TRATA la publicacion: ids de la taxonomia de `topics`, la misma
     * que usan las personas. No confundir con `category`, que es la carpeta con
     * la que un creador ordena SUS audios.
     *
     * Va en la misma peticion que la publicacion a proposito: un segundo viaje
     * para etiquetar podria fallar y dejar el video publicado y sin clasificar
     * para siempre.
     */
    topicIds: string[] = [],
  ): Promise<Post> {
    const dto = await apiRequest<PostDto>(`${API_V1}/posts`, {
      method: 'POST',
      body: JSON.stringify({
        body,
        category: category ?? null,
        topic_ids: topicIds,
        media: media.map((m) => ({
          storage_path: m.storagePath,
          media_type: m.mediaType,
          // Metadata calculada en el dispositivo. Un backend anterior a la
          // migracion 0021 ignora estos campos sin quejarse (Pydantic descarta
          // lo que no conoce), asi que la app funciona contra ambas versiones.
          width: m.width ?? null,
          height: m.height ?? null,
          duration_s: m.durationS ?? null,
          bytes: m.bytes ?? null,
          poster_path: m.posterPath ?? null,
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
    changes: {
      body?: string;
      media?: UploadedMedia[];
      category?: string | null;
      /**
       * Ausente = no se tocan los temas. Presente (aunque sea vacio) = se
       * reemplazan, lo que permite QUITAR uno mal elegido.
       */
      topicIds?: string[];
    },
    currentUserId?: string | null,
  ): Promise<Post> {
    const payload: Record<string, unknown> = {};
    if (changes.body !== undefined) payload.body = changes.body;
    if (changes.category !== undefined) payload.category = changes.category;
    if (changes.topicIds !== undefined) payload.topic_ids = changes.topicIds;
    if (changes.media !== undefined) {
      payload.media = changes.media.map((m) => ({
        storage_path: m.storagePath,
        media_type: m.mediaType,
        width: m.width ?? null,
        height: m.height ?? null,
        duration_s: m.durationS ?? null,
        bytes: m.bytes ?? null,
        poster_path: m.posterPath ?? null,
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
