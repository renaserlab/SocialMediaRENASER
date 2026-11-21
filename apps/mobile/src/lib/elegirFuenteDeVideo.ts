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
