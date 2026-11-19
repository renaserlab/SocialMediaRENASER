/**
 * La decision de `bestVideoSource`, sin React Native.
 *
 * Vive aparte para poder probarla en Node (`elegirFuenteDeVideo.test.mts`):
 * `videoSource.ts` importa `Platform`, que no carga fuera de la app. La regla
 * no cambia con los videos en S3 (opcion B): el mapper ya deja en
 * `streamUrl`/`mediaUrl` las URLs que firmo la API, asi que aqui solo se elige
 * cual usar, igual que con Supabase.
 */
export function elegirFuenteDeVideo(
  post: { streamUrl?: string; mediaUrl?: string },
  esNativo: boolean,
): { uri: string; isStream: boolean } | null {
  if (post.streamUrl && esNativo) {
    return { uri: post.streamUrl, isStream: true };
  }
  if (post.mediaUrl) return { uri: post.mediaUrl, isStream: false };
  return null;
}
