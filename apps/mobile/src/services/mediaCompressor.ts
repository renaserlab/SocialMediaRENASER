/**
 * Compresion en el dispositivo antes de subir, que es lo que hacen TikTok o
 * Instagram: un video de galeria de 100 MB suele quedar en 10-20 MB sin
 * diferencia visible en un feed. Ahorra datos del usuario y tiempo de subida.
 *
 * `react-native-compressor` es un modulo NATIVO y no viaja dentro de Expo Go.
 * Alli el require falla (o el modulo nativo no esta registrado) y la app se
 * caia al arrancar, porque `storage.ts` importa este archivo. Se carga de forma
 * protegida: si no esta disponible, se sube el archivo sin comprimir, que es
 * justo lo que ya hace la variante web.
 *
 * Con una build propia (EAS) el modulo si esta y la compresion se activa sola.
 */

type VideoMeta = {
  extension: string;
  size: number;
  duration: number;
  width: number;
  height: number;
};

type ThumbnailResult = {
  path: string;
  size: number;
  mime: string;
  width: number;
  height: number;
};

type CompressorModule = {
  Image: { compress: (uri: string, options?: unknown) => Promise<string> };
  Video: {
    compress: (
      uri: string,
      options: unknown,
      onProgress?: (progress: number) => void,
    ) => Promise<string>;
  };
  getVideoMetaData: (filePath: string) => Promise<VideoMeta>;
  clearCache?: (cacheDir?: string) => Promise<string>;
  createVideoThumbnail: (
    fileUrl: string,
    options?: { quality?: number; cacheName?: string },
  ) => Promise<ThumbnailResult>;
};

function loadCompressor(): CompressorModule | null {
  try {
    // Carga perezosa: en Expo Go esto lanza y se degrada sin romper la app.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-compressor') as Partial<CompressorModule>;
    // Se comprueba la forma, no solo que el require pase: un modulo a medias
    // fallaria despues, al comprimir, y ahi ya seria un fallo en caliente.
    if (typeof mod?.Video?.compress === 'function' && typeof mod?.Image?.compress === 'function') {
      return mod as CompressorModule;
    }
    return null;
  } catch {
    return null;
  }
}

const native = loadCompressor();

/** false en Expo Go y en web; `storage.ts` ya protege cada uso con esto. */
export const compressionAvailable = native !== null;

/**
 * Ajustes del video de salida.
 *
 * Con `auto`, la libreria decide y su tope por defecto son 640 px: se ve
 * borroso en un short a pantalla completa. Se fija a mano el equilibrio que
 * usan las redes de video para su calidad estandar: lado mayor de 1280 px
 * (720p) y ~2.5 Mbps H.264. Un minuto queda en ~19 MB en vez de los 90-160 MB
 * que pesa el original de camara a 10-12 Mbps, y la diferencia en un movil es
 * imperceptible.
 */
const VIDEO_OPCIONES = {
  compressionMethod: 'manual' as const,
  maxSize: 1280,
  bitrate: 2_500_000,
};

/** Comprime un video. Devuelve la ruta local del resultado. */
export async function compressVideo(
  uri: string,
  onProgress?: (ratio: number) => void,
): Promise<string> {
  if (!native) return uri;
  return native.Video.compress(uri, VIDEO_OPCIONES, (progress) =>
    onProgress?.(progress),
  );
}

/** Comprime una imagen. Devuelve la ruta local del resultado. */
export async function compressImage(uri: string): Promise<string> {
  if (!native) return uri;
  return native.Image.compress(uri, { compressionMethod: 'auto' });
}

/** Medidas del medio, para guardarlas junto al post y reservar su hueco. */
export type MediaMetadata = {
  width?: number;
  height?: number;
  /** Duracion en segundos (solo video). */
  durationS?: number;
  bytes?: number;
};

/**
 * Lee las medidas reales de un video local. `null` si el modulo nativo no
 * esta (Expo Go, web): el backend puede completarlas despues.
 */
export async function readVideoMetadata(uri: string): Promise<MediaMetadata | null> {
  if (!native) return null;
  try {
    const meta = await native.getVideoMetaData(uri);
    return {
      width: meta.width || undefined,
      height: meta.height || undefined,
      durationS: meta.duration || undefined,
      bytes: meta.size || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Extrae un fotograma del video como imagen local: es el poster que se ve al
 * instante en el muro y en los shorts mientras el video prepara. `null` donde
 * el modulo nativo no esta; esos videos quedan sin poster hasta que el
 * pipeline del backend lo genere.
 *
 * `nombreEnCache` es para quien va a pedir la misma portada mas de una vez (el
 * chat): en Android el compresor la guarda con ese nombre en su carpeta
 * temporal y, si ya existe, la devuelve sin volver a abrir el video. `uri`
 * puede ser un archivo del telefono o una direccion `https`.
 */
export async function createVideoPoster(
  uri: string,
  nombreEnCache?: string,
): Promise<{ uri: string; width?: number; height?: number } | null> {
  if (!native || typeof native.createVideoThumbnail !== 'function') return null;
  try {
    const thumb = await native.createVideoThumbnail(
      uri,
      nombreEnCache ? { quality: 0.8, cacheName: nombreEnCache } : { quality: 0.8 },
    );
    if (!thumb?.path) return null;
    return { uri: thumb.path, width: thumb.width || undefined, height: thumb.height || undefined };
  } catch {
    return null;
  }
}

/**
 * Borra las portadas de video que el compresor guarda en su carpeta temporal.
 * Para el cierre de sesion: son fotogramas de videos privados de un chat.
 */
export async function clearVideoPosters(): Promise<void> {
  if (!native || typeof native.clearCache !== 'function') return;
  try {
    await native.clearCache();
  } catch {
    // Es una carpeta temporal: el sistema la limpia igual cuando quiere.
  }
}
