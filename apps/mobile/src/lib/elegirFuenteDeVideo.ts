/**
 * La decision de `bestVideoSource`, sin React Native.
 *
 * Vive aparte para poder probarla en Node (`elegirFuenteDeVideo.test.mts`):
 * `videoSource.ts` importa `Platform`, que no carga fuera de la app. La regla
 * no cambia con los videos en S3 (opcion B): el mapper ya deja en
 * `streamUrl`/`mediaUrl` las URLs que firmo la API, asi que aqui solo se elige
 * cual usar, igual que con Supabase.
 *
 * CALIDADES (bandera de la API, apagada de fabrica). Si la publicacion trae
 * `variantes` —el mismo video en 480/560/720—, se reproduce la que diga
 * `elegir` (una vez por video, ver `elegirVariante.ts`), como MP4 progresivo
 * y antes que el HLS: un MP4 entra en la cache de disco de expo-video en iOS
 * y Android, y el HLS en iOS no. Sin variantes, exactamente lo de siempre.
 */
import type { VarianteDeVideo } from './elegirVariante.ts';

export function elegirFuenteDeVideo(
  post: { streamUrl?: string; mediaUrl?: string; variantes?: readonly VarianteDeVideo[] },
  esNativo: boolean,
  elegir?: (variantes: readonly VarianteDeVideo[]) => VarianteDeVideo | null,
): { uri: string; isStream: boolean; alto?: number } | null {
  if (post.variantes && post.variantes.length > 0 && elegir) {
    const variante = elegir(post.variantes);
    if (variante) return { uri: variante.url, isStream: false, alto: variante.alto };
  }
  if (post.streamUrl && esNativo) {
    return { uri: post.streamUrl, isStream: true };
  }
  if (post.mediaUrl) return { uri: post.mediaUrl, isStream: false };
  return null;
}

/**
 * ¿Es `ruta` el MP4 derivado para el feed (`…/derived/<id>/feed.mp4` en
 * Supabase, `…/feed-720-v1.mp4` en S3)? Esos los genera el pipeline con
 * `+faststart` y audio intercalado; el original subido no siempre lo esta.
 */
export function esMp4DelFeed(ruta: string | null | undefined): boolean {
  if (!ruta) return false;
  const sinQuery = ruta.split('?')[0] ?? ruta;
  return /(^|\/)feed[^/]*\.mp4$/i.test(sinQuery);
}

/**
 * La fuente para el MURO DE INICIO: la misma eleccion, salvo que si iba a
 * ser HLS y existe el MP4 del feed, se reproduce ese MP4.
 *
 * POR QUE (medido el 24/11/2026 con el video «landing» de Darren Supa, uno de
 * los tres HLS que hay en Supabase). Arrancar un HLS de Supabase son tres
 * viajes encadenados: la lista maestra (0,45-0,8 s, la sirve la API y firma
 * cada segmento), la de la calidad (0,6 s) y el primer segmento, que casi
 * siempre FALLA la cache del CDN de Supabase (1,1-1,2 s solo hasta el primer
 * byte) porque cada lista trae firmas nuevas y la firma forma parte de la
 * clave de cache. Ademas ExoPlayer empieza en 360p y salta a 720p un par de
 * segundos despues (otra lista y otros segmentos): se ve borroso y luego
 * nitido. En el telefono de Luis: 2,2 / 2,2 / 4,1 s del gesto a reproducir.
 *
 * El MP4 del feed de ese mismo video (720p, 2,5 Mbps, `moov` al principio y
 * audio intercalado) da su primer mega en 0,2-0,26 s, un solo pedido, y SI
 * entra en la cache de disco de expo-video y en la precarga nativa del
 * primer mega, que el HLS no tiene: volver a el no toca la red. Los MP4 del
 * mismo telefono arrancan en 0,52-0,65 s contando el deslizamiento.
 *
 * Solo el muro, a proposito: ahi se cambia de video cada pocos segundos y
 * manda el arranque. Las publicaciones, cursos e historias siguen con lo de
 * siempre. Lo que se pierde es la calidad adaptativa en una red muy mala; el
 * MP4 del feed esta acotado a 720p justamente para el muro.
 */
export function elegirFuenteDelMuro(
  post: {
    streamUrl?: string;
    mediaUrl?: string;
    mediaPath?: string;
    variantes?: readonly VarianteDeVideo[];
  },
  esNativo: boolean,
  elegir?: (variantes: readonly VarianteDeVideo[]) => VarianteDeVideo | null,
): { uri: string; isStream: boolean; alto?: number } | null {
  const fuente = elegirFuenteDeVideo(post, esNativo, elegir);
  if (fuente?.isStream && post.mediaUrl && esMp4DelFeed(post.mediaPath)) {
    return { uri: post.mediaUrl, isStream: false };
  }
  return fuente;
}
