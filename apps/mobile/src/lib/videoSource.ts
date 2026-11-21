import { Platform } from 'react-native';

import { elegirFuenteDeVideo } from '@/lib/elegirFuenteDeVideo';
import { crearMemoriaDeCalidad, type VarianteDeVideo } from '@/lib/elegirVariante';
import { medicionDeRedActual } from '@/lib/medidorDeRed';

/**
 * La calidad elegida para cada video en esta sesion: una vez por video,
 * aunque la lista se vuelva a armar al renovar las firmas.
 */
const memoriaDeCalidad = crearMemoriaDeCalidad();

/**
 * Elige la mejor fuente disponible para reproducir un video.
 *
 * Cadena de respaldo, de mejor a peor:
 *   0. Una de las `variantes` (480/560/720), si la API las manda: la que da
 *      la red medida, elegida UNA vez por video. Sin medicion, la de arriba,
 *      que es el mismo `mediaUrl` de siempre.
 *   1. HLS (streaming por segmentos con calidades adaptativas) — solo en
 *      nativo: el <video> del navegador no reproduce HLS salvo en Safari.
 *   2. MP4 firmado — `mediaUrl` ya apunta a la version optimizada del feed
 *      cuando existe (feed_path) y al original como ultimo recurso, asi que el
 *      contenido anterior al pipeline sigue funcionando igual que siempre.
 *
 * En videos de S3 (opcion B) las dos URLs son las que firmo la API: el mapper
 * ya las puso en `streamUrl`/`mediaUrl`. Si la API no manda HLS, se usa el MP4
 * de 720p, que es lo que evita que una lista rota rompa el video.
 *
 * `isStream` decide si conviene la cache de disco de expo-video: para MP4 si;
 * para HLS no (no esta soportada en iOS y los segmentos ya son incrementales).
 */
export function bestVideoSource(post: {
  id?: string;
  streamUrl?: string;
  mediaUrl?: string;
  variantes?: readonly VarianteDeVideo[];
}): { uri: string; isStream: boolean; alto?: number } | null {
  return elegirFuenteDeVideo(post, Platform.OS !== 'web', (variantes) =>
    memoriaDeCalidad.elegir(post.id, variantes, medicionDeRedActual()),
  );
}
