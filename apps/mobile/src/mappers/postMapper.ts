import { traduceEnElIdiomaActual } from '@/i18n';
import { API_BASE_URL, API_V1 } from '@/services/api';
import { profileImageUrl } from '@/services/storage';
import type { Comment, Post } from '@/types';

export type PostAuthorDto = {
  id: string;
  full_name: string;
  username: string | null;
  avatar_path: string | null;
};

export type PostMediaDto = {
  /** Identificador del medio; con el se pide la playlist HLS al backend. */
  id?: string | null;
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
  /** De que trata (migracion 0027). Vacio en el contenido sin clasificar. */
  topic_ids?: string[];
  /**
   * Etiquetas sociales del texto, como se escribieron (migracion 0031).
   * Opcional: un backend anterior no manda el campo y no pasa nada.
   */
  hashtags?: string[];
  /** A quien etiqueta la publicacion (migracion 0032). Opcional por lo mismo. */
  mentions?: PostAuthorDto[];
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
  /**
   * Cuantas veces se republico y si fui yo (migracion 0042). Opcionales: un
   * backend anterior no manda los campos y la tarjeta pinta cero, que es la
   * verdad de antes.
   */
  reposts_count?: number;
  reposted_by_me?: boolean;
  /**
   * QUIEN la esta compartiendo, cuando llega por una republicacion.
   *
   * `author` sigue siendo el autor ORIGINAL: son dos personas distintas y la
   * tarjeta las ensena las dos. Ausente en una publicacion normal.
   */
  repost?: {
    id: string;
    author: PostAuthorDto;
    comentario?: string;
    created_at: string;
  } | null;
};

export type CommentDto = {
  id: string;
  post_id: string;
  author: PostAuthorDto;
  parent_id: string | null;
  body: string;
  created_at: string;
  /* Vienen en el propio comentario para no pedir una vez por fila. Opcionales:
     un servidor sin la 0048 no los manda. */
  likes_count?: number;
  viewer_reacted?: boolean;
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
  if (secs < 60) return traduceEnElIdiomaActual('time.now');
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
    // Un backend anterior a la migracion 0027 no manda el campo: sin temas, no
    // sin publicacion. Lo mismo vale para las etiquetas (0031) y las personas
    // etiquetadas (0032): el `?? []` es lo que permite desplegar el movil antes
    // de que un humano apruebe las migraciones.
    topicIds: dto.topic_ids ?? [],
    hashtags: dto.hashtags ?? [],
    mentions: (dto.mentions ?? []).map((persona) => ({
      id: persona.id,
      nombre: authorName(persona),
      usuario: persona.username ?? undefined,
      avatarUrl: profileImageUrl(persona.avatar_path),
    })),
    id: dto.id,
    author: authorName(dto.author),
    authorId: dto.author.id,
    authorAvatarUrl: profileImageUrl(dto.author.avatar_path),
    username: authorHandle(dto.author),
    body: dto.body,
    createdAt: formatRelativeTime(dto.created_at),
    createdAtIso: dto.created_at,
    likes: dto.likes_count,
    // La reaccion propia viaja CON la publicacion. El muro la recogia aparte
    // (`listFeed`), pero el feed de video se quedaba sin ella y pintaba todos
    // los corazones vacios.
    likedByMe: dto.liked_by_me ?? undefined,
    repostsCount: dto.reposts_count ?? 0,
    repostedByMe: dto.reposted_by_me ?? false,
    /*
      Quien comparte, APARTE de quien escribio. Nunca se sobreescribe `author`
      con esto: republicar no cambia de quien es lo publicado.
    */
    repost: dto.repost
      ? {
          id: dto.repost.id,
          autor: authorName(dto.repost.author),
          autorId: dto.repost.author.id,
          autorAvatarUrl: profileImageUrl(dto.repost.author.avatar_path),
          comentario: dto.repost.comentario ?? '',
          fecha: formatRelativeTime(dto.repost.created_at),
        }
      : undefined,
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
    // La playlist HLS la sirve el backend, que firma cada segmento. Solo se
    // construye si el video fue transcodificado (stream_path) y conocemos el
    // id del medio.
    streamUrl:
      first?.stream_path && first?.id
        ? `${API_BASE_URL}${API_V1}/media/${first.id}/hls/master.m3u8`
        : undefined,
  };
}
