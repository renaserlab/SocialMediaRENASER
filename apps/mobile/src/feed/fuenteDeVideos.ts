import { PostRepository, type FeedKind } from '@/repositories/PostRepository';
import { bestVideoSource } from '@/lib/videoSource';
import type { ReelItem } from '@/components/ShortVideoItem';
import type { Post } from '@/types';

/**
 * De donde salen los videos del Inicio.
 *
 * POR QUE ESTA CAPA. El documento pide que "Para ti" funcione HOY con el
 * contenido que ya existe, y el Plan Maestro pide que mas adelante ese mismo
 * hueco lo ocupe un recomendador de verdad (candidatos → ranking → diversidad)
 * sin rehacer la pantalla. Si la pantalla llamara directamente al repositorio
 * —o peor, ordenara por fecha ella misma— cambiar de estrategia obligaria a
 * tocar la interfaz, el estado, la paginacion y las pruebas a la vez.
 *
 * Asi que la pantalla no sabe de donde vienen los videos: pide un lote a una
 * FUENTE y pinta lo que le den. Cambiar el orden del feed sera escribir otra
 * funcion aqui y devolverla en `fuenteDeInicio`, nada mas.
 *
 *   Pantalla → FuenteDeVideos → (hoy) cronologico del backend
 *                             → (manana) RecommendationService
 */

/** Punto por el que continuar. `null` = empezar por el principio. */
export type CursorDeVideos = {
  /** Fecha ISO del ultimo elemento recibido (paginacion por cursor). */
  creadoEn?: string;
  /** Id del ultimo elemento: desempata cuando dos comparten instante. */
  id?: string;
  /** Cuantos se llevan pedidos; solo lo usa un backend sin cursor. */
  desplazamiento: number;
};

export type LoteDeVideos = {
  items: ReelItem[];
  /** false cuando el servidor ya no tiene nada mas que dar. */
  hayMas: boolean;
  /**
   * Por donde seguir. Lo calcula la FUENTE, a partir de lo que devolvio el
   * servidor, no de lo que sobrevive al filtro.
   *
   * Importa mas de lo que parece. Una publicacion con video puede no ser
   * reproducible (por ejemplo, si fallo el firmado de su URL) y entonces se
   * descarta. Si el cursor saliera de la lista ya filtrada:
   *
   *  - una pagina entera de descartes dejaria el feed vacio Y sin cursor, es
   *    decir, sin forma de pedir la siguiente: «todavia no hay videos» para
   *    siempre, con contenido de sobra al otro lado;
   *  - y el `desplazamiento` contaria de menos, asi que contra un servidor que
   *    solo entienda `offset` la pagina siguiente se solaparia con la anterior.
   */
  siguienteCursor: CursorDeVideos | null;
};

export type FuenteDeVideos = {
  /**
   * Identifica la fuente. Cambiar de clave es cambiar de feed: la pantalla lo
   * usa para saber que tiene que empezar de cero y no mezclar dos listas.
   */
  clave: string;
  cargar(cursor: CursorDeVideos | null, limite: number): Promise<LoteDeVideos>;
};

/**
 * Cuantos videos por peticion.
 *
 * Corto a proposito: lo que se mide es cuanto tarda en verse el PRIMERO, y
 * pedir treinta con sus firmas de Storage para ensenar uno solo retrasa
 * exactamente eso. El resto llega mientras la persona mira el primero.
 */
export const VIDEOS_POR_PAGINA = 6;

/** Publicacion con video → elemento del feed vertical. */
export function aReel(post: Post): ReelItem | null {
  const source = bestVideoSource(post);
  if (!source) return null;
  return {
    id: post.id,
    author: post.author,
    authorId: post.authorId,
    avatarUrl: post.authorAvatarUrl,
    caption: post.body,
    uri: source.uri,
    isStream: source.isStream,
    posterUrl: post.posterUrl,
    posterPath: post.posterPath,
    createdAtIso: post.createdAtIso,
    likes: post.likes,
    comments: post.commentsCount ?? 0,
  };
}

/**
 * Fuente respaldada por el backend actual: videos publicados, del mas reciente
 * al mas antiguo, con el filtro de feed que corresponda.
 *
 * Es la estrategia V1 del documento: "alimentarse de contenido real existente"
 * y que un video nuevo entre en la cola en cuanto se publica. No hay ranking
 * todavia, y por eso vive aqui detras y no dentro de la pantalla.
 */
function fuenteDelBackend(
  clave: string,
  feed: FeedKind,
  usuarioId: string | null | undefined,
): FuenteDeVideos {
  return {
    clave,
    async cargar(cursor, limite) {
      const posts = await PostRepository.listVideos(usuarioId, {
        limit: limite,
        feed,
        // Cursor Y desplazamiento a la vez: el backend nuevo usa el cursor (no
        // repite aunque entren videos nuevos entre pagina y pagina) y uno
        // anterior lo ignora y se apoya en el desplazamiento. La misma app
        // sirve contra las dos versiones.
        offset: cursor?.desplazamiento ?? 0,
        beforeCreatedAt: cursor?.creadoEn,
        beforeId: cursor?.id,
      });
      const items = posts.map(aReel).filter((r): r is ReelItem => r !== null);
      // El cursor sale del ULTIMO POST recibido, reproducible o no.
      const ultimo = posts[posts.length - 1];
      const siguienteCursor = ultimo
        ? {
            creadoEn: ultimo.createdAtIso,
            id: ultimo.id,
            desplazamiento: (cursor?.desplazamiento ?? 0) + posts.length,
          }
        : null;
      return { items, hayMas: posts.length === limite, siguienteCursor };
    },
  };
}

/** Las pestanas del Inicio. `live` no es un feed de videos: se pinta aparte. */
export type PestanaDeInicio = 'paraTi' | 'siguiendo' | 'live';

/**
 * La fuente de una pestana.
 *
 * `usuarioId` solo sirve para marcar cuales son propios al pintar; quien pide
 * el contenido —y a quien sigue— lo resuelve el backend desde el token.
 */
export function fuenteDeInicio(
  pestana: Exclude<PestanaDeInicio, 'live'>,
  usuarioId: string | null | undefined,
): FuenteDeVideos {
  return pestana === 'siguiendo'
    ? fuenteDelBackend('siguiendo', 'following', usuarioId)
    : fuenteDelBackend('paraTi', 'all', usuarioId);
}
