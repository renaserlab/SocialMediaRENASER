import { Platform } from 'react-native';

/**
 * Elige la mejor fuente disponible para reproducir un video.
 *
 * Cadena de respaldo, de mejor a peor:
 *   1. HLS (streaming por segmentos con calidades adaptativas) — solo en
 *      nativo: el <video> del navegador no reproduce HLS salvo en Safari.
 *   2. MP4 firmado — `mediaUrl` ya apunta a la version optimizada del feed
 *      cuando existe (feed_path) y al original como ultimo recurso, asi que el
 *      contenido anterior al pipeline sigue funcionando igual que siempre.
 *
 * `isStream` decide si conviene la cache de disco de expo-video: para MP4 si;
 * para HLS no (no esta soportada en iOS y los segmentos ya son incrementales).
 */
export function bestVideoSource(post: {
  streamUrl?: string;
  mediaUrl?: string;
}): { uri: string; isStream: boolean } | null {
  if (post.streamUrl && Platform.OS !== 'web') {
    return { uri: post.streamUrl, isStream: true };
  }
  if (post.mediaUrl) return { uri: post.mediaUrl, isStream: false };
  return null;
}
