import { decidirLote } from '@/feed/decisionDeFuente';
import { crearPrecargaDeInicio } from '@/feed/precargaDeInicio';
import { reelNecesitaUrls, renovarUrls } from '@/feed/urlsDeMedios';
import { PostRepository, resolveMediaUrls, type FeedKind } from '@/repositories/PostRepository';
import { RecommendationRepository } from '@/repositories/RecommendationRepository';
import { bestVideoSource } from '@/lib/videoSource';
import { medicionDeVideo } from '@/lib/medicionDeVideoEnApp';
import type { ReelItem } from '@/components/ShortVideoItem';
import { useAppStore } from '@/store/useAppStore';
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
  /**
   * Con que version del algoritmo se ordeno este lote, para poder mandarla en
   * las impresiones y saber DESPUES si aquella ordenacion producia algo.
   *
   * Es OPCIONAL porque hay lotes que no vienen de ningun algoritmo: los de la
   * fuente cronologica y los del respaldo. Ahi no se rellena con un valor
   * inventado; un lote sin version es exactamente eso, y decirlo asi evita
   * apuntarle al recomendador un orden que no es suyo.
   */
  versionDelAlgoritmo?: string;
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

/**
 * Lleva al estado compartido lo que el servidor dice de estas publicaciones.
 *
 * POR QUE HACE FALTA. El feed de video mapea `Post` a `ReelItem` y el elemento
 * resultante no lleva la reaccion propia. Sin esto, Inicio no tenia forma de
 * saber a que habia reaccionado quien mira, y pintaba TODOS los corazones
 * vacios aunque el muro los pintara llenos: los dos ensenan las mismas
 * publicaciones, asi que la diferencia se veia a simple vista.
 *
 * Va al store y no dentro de `ReelItem` a proposito: la cola de videos se
 * guarda en disco como instantanea (`cacheDeVideos`), y meter ahi el estado de
 * una cuenta significaria enseñarle a la siguiente persona que inicie sesion en
 * ese telefono los me gusta de la anterior.
 */
function sembrarReacciones(posts: Post[]): void {
  if (posts.length === 0) return;
  useAppStore.getState().aplicarLikesDelServidor(
    posts.map((post) => post.id),
    posts.filter((post) => post.likedByMe).map((post) => post.id),
    Object.fromEntries(posts.map((post) => [post.id, post.likes])),
  );
}

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
    // El peso solo vale si lo que se reproduce es el archivo medido (ver
    // `mediaBytes` en el tipo); para HLS no hay un archivo que pesar.
    // Con una calidad distinta de `mediaUrl`, ese peso tampoco es el suyo.
    bytes: source.isStream || source.uri !== post.mediaUrl ? undefined : post.mediaBytes,
    almacen: post.mediaAlmacen ?? 'supabase',
    posterUrl: post.posterUrl,
    posterPath: post.posterPath,
    // Las medidas viajan con el elemento: la celda las necesita para decidir
    // si llena la pantalla o ensena el video entero (ver `ShortVideoItem`).
    width: post.mediaWidth,
    height: post.mediaHeight,
    createdAtIso: post.createdAtIso,
    likes: post.likes,
    comments: post.commentsCount ?? 0,
    // Solo en videos de S3: sus URLs caducan y hay que poder renovarlas.
    urlsExpiran: post.mediaAlmacen === 's3' ? post.urlsExpiran : undefined,
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
      sembrarReacciones(posts);
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

/**
 * Fuente RECOMENDADA, con la cronologica debajo por si acaso.
 *
 * Aqui es donde el recomendador entra en Inicio, y entra sin que la pantalla se
 * entere: devuelve exactamente el mismo `LoteDeVideos` que la fuente de
 * siempre. Esa era toda la razon de ser de esta capa.
 *
 * EL RESPALDO NO ES DECORATIVO, es una condicion de aceptacion. El
 * recomendador puede fallar, estar apagado o no tener todavia con que
 * personalizar, y en ninguno de esos casos puede quedarse Inicio en negro. Se
 * cae a la fuente cronologica y la persona ve videos igual; lo unico que
 * cambia es el orden.
 *
 * Los tres caminos de vuelta a lo cronologico:
 *
 *   - la peticion falla (red, servidor dormido, 500);
 *   - responde vacio (personalizacion apagada, o nada que ordenar);
 *   - la primera pagina no trae ni un video reproducible.
 *
 * Una vez que se cae, se queda caido para el resto de la sesion de esa fuente:
 * paginar mezclando dos ordenaciones distintas repetiria y saltaria videos.
 */
function fuenteRecomendada(usuarioId: string | null | undefined): FuenteDeVideos {
  const respaldo = fuenteDelBackend('paraTi', 'all', usuarioId);
  let usarRespaldo = false;

  return {
    // La MISMA clave que la fuente cronologica a proposito: para la pantalla
    // sigue siendo «Para ti». Cambiarla vaciaria la lista y la instantanea
    // guardada cada vez que el recomendador dejara de estar disponible.
    clave: 'paraTi',
    async cargar(cursor, limite) {
      /*
        Un cursor con fecha o id solo lo produce la fuente cronologica: el
        recomendador pagina por posicion. Si llega uno, la primera pagina salio
        del respaldo aunque la pidiera OTRA instancia de esta fuente (la
        precarga del arranque, ver `precargarInicio`), y mezclar ahora el
        recomendador repetiria y saltaria videos.
      */
      if (cursor && (cursor.creadoEn !== undefined || cursor.id !== undefined)) {
        usarRespaldo = true;
      }
      if (usarRespaldo) return respaldo.cargar(cursor, limite);
      const desplazamiento = cursor?.desplazamiento ?? 0;
      try {
        /*
          El recomendador ya no devuelve una lista pelada, sino la lista MAS el
          contexto con el que se ordeno. Ese contexto es lo que despues permite
          leer las impresiones: sin la version del algoritmo, «se vio» y «se vio
          gracias a esta ordenacion» son el mismo dato.
        */
        const respuesta = await RecommendationRepository.listContent(
          { limit: limite, offset: desplazamiento, media: 'video' },
          usuarioId,
        );
        const posts = respuesta.items;
        // Solo cuentan los de la primera pagina: la medicion exige que antes
        // se marcara `feed_pedido` y guarda cada hito una sola vez.
        medicionDeVideo.hito('feed_respuesta');
        // Las firmas de Storage van en una segunda fase, igual que en el muro:
        // lo que se mide es cuanto tarda en verse el PRIMER video.
        const conMedios = posts.length > 0 ? await resolveMediaUrls(posts) : [];
        medicionDeVideo.hito('urls_firmadas');
        sembrarReacciones(conMedios);
        const items = conMedios.map(aReel).filter((r): r is ReelItem => r !== null);

        const decision = decidirLote({
          recibidas: posts.length,
          reproducibles: items.length,
          desplazamiento,
        });
        if (decision === 'respaldo') {
          usarRespaldo = true;
          return respaldo.cargar(null, limite);
        }
        if (decision === 'fin') {
          return { items: [], hayMas: false, siguienteCursor: null };
        }
        return {
          items,
          hayMas: posts.length === limite,
          // El recomendador ordena por relevancia, no por fecha, asi que su
          // paginacion es por posicion. El orden es estable dentro del dia
          // (ver `semilla_de_exploracion` en el backend), asi que avanzar por
          // desplazamiento no repite ni salta.
          siguienteCursor: { desplazamiento: desplazamiento + posts.length },
          versionDelAlgoritmo: respuesta.algorithmVersion,
        };
      } catch (error) {
        console.warn('[inicio] el recomendador fallo; se usa el orden cronologico', error);
        usarRespaldo = true;
        return respaldo.cargar(cursor, limite);
      }
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
 *
 * `personalizar` sale de la SESION, no del perfil. Parece un detalle y no lo
 * es: el perfil se carga en paralelo al arrancar y puede tardar, asi que
 * decidir con el habria dejado el Inicio en orden cronologico durante toda esa
 * primera carga —justo la que importa— y sin forma de rehacerla despues.
 */
export function fuenteDeInicio(
  pestana: Exclude<PestanaDeInicio, 'live'>,
  usuarioId: string | null | undefined,
  { personalizar = false }: { personalizar?: boolean } = {},
): FuenteDeVideos {
  if (pestana === 'siguiendo') return fuenteDelBackend('siguiendo', 'following', usuarioId);
  /*
    «Siguiendo» NO se personaliza y no debe hacerlo: quien entra ahi ha pedido
    ver lo de la gente que sigue, en el orden en que ocurrio. Reordenarlo seria
    quitarle el control de lo unico que controla.

    «Para ti» sin sesion tampoco: el recomendador necesita saber para quien
    recomienda, y sin token no hay a quien preguntar.
  */
  const base = fuenteParaTi(usuarioId, personalizar);
  const firma = firmaDeLaPrecarga(personalizar);
  return {
    clave: base.clave,
    cargar(cursor, limite) {
      // La primera pagina puede estar ya pedida desde el arranque. Si la
      // precarga fallo, se pide de nuevo aqui: para quien mira es lo mismo que
      // antes, sin la ventaja.
      if (cursor === null && limite === VIDEOS_POR_PAGINA) {
        const precargada = precarga.tomar(firma);
        if (precargada) return precargada.catch(() => base.cargar(cursor, limite));
      }
      return base.cargar(cursor, limite);
    },
  };
}

function fuenteParaTi(usuarioId: string | null | undefined, personalizar: boolean): FuenteDeVideos {
  return personalizar
    ? fuenteRecomendada(usuarioId)
    : fuenteDelBackend('paraTi', 'all', usuarioId);
}

function firmaDeLaPrecarga(personalizar: boolean): string {
  return personalizar ? 'paraTi:recomendado' : 'paraTi:cronologico';
}

/** Una sola precarga por arranque (ver `precargaDeInicio.ts`). */
const precarga = crearPrecargaDeInicio();

/**
 * Pide YA la primera pagina de «Para ti», sin esperar a que Inicio se monte.
 *
 * La llama el arranque en cuanto sabe si hay sesion. Tiene que pedir el MISMO
 * feed que pedira Inicio: con sesion, el recomendador (con su respaldo); sin
 * ella, el cronologico. Si al final Inicio quiere otro (se inicio o se cerro
 * sesion entretanto), la firma no coincide y se pide de nuevo.
 */
export function precargarInicio(
  usuarioId: string | null,
  { personalizar }: { personalizar: boolean },
): void {
  precarga.lanzar(firmaDeLaPrecarga(personalizar), usuarioId, () =>
    fuenteParaTi(usuarioId, personalizar).cargar(null, VIDEOS_POR_PAGINA),
  );
}

/** Lo precargado para otra cuenta no se le ensena a esta. */
export function descartarPrecargaSiNoEsDe(usuarioId: string | null): void {
  precarga.descartarSiNoEsDe(usuarioId);
}

/**
 * Tras responder (o saltar) el cuestionario, el recomendador ordena con otras
 * preferencias: lo precargado antes ya no es lo que le toca ver.
 */
export function descartarPrecargaDeInicio(): void {
  precarga.descartar();
}

/**
 * Renueva las URLs de los videos de S3 (opcion B) de una lista del feed que
 * caducan, o de los `forzar` aunque no caduquen (un error de reproduccion).
 *
 * Sin nada que renovar no pide nada y devuelve la MISMA lista: quien llama
 * puede comparar por identidad para no redibujar. Solo se copian la fuente y
 * la portada; el resto del elemento (contadores, texto) no se toca.
 */
export async function renovarUrlsDeReels(
  items: ReelItem[],
  forzar: string[] = [],
): Promise<{ items: ReelItem[]; renovados: string[] }> {
  return renovarUrls(items, {
    necesita: (reel) => reelNecesitaUrls(reel),
    forzar,
    pedir: async (ids) => {
      const posts = await PostRepository.listByIds(ids);
      return posts.map(aReel).filter((r): r is ReelItem => r !== null);
    },
    combinar: (viejo, nuevo) => ({
      ...viejo,
      uri: nuevo.uri,
      isStream: nuevo.isStream,
      posterUrl: nuevo.posterUrl,
      posterPath: nuevo.posterPath,
      urlsExpiran: nuevo.urlsExpiran,
    }),
  });
}
