/**
 * En web no hay modulo nativo de compresion: react-native-compressor romperia
 * el bundle. Se sube el archivo tal cual (en escritorio el ancho de banda y la
 * bateria no son el cuello de botella que si lo son en movil).
 */
export const compressionAvailable = false;

export async function compressVideo(
  uri: string,
  _onProgress?: (ratio: number) => void,
): Promise<string> {
  return uri;
}

export async function compressImage(uri: string): Promise<string> {
  return uri;
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
 * En web las medidas del video se leen con el propio reproductor del
 * navegador, sin descargar mas que los metadatos.
 */
export async function readVideoMetadata(uri: string): Promise<MediaMetadata | null> {
  if (typeof document === 'undefined') return null;
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      resolve({
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
        durationS: Number.isFinite(video.duration) ? video.duration : undefined,
      });
      video.src = '';
    };
    video.onerror = () => resolve(null);
    video.src = uri;
  });
}

/**
 * Poster desde el navegador: se pinta el primer fotograma en un canvas.
 * Devuelve un blob URL local listo para subirse como imagen.
 */
export async function createVideoPoster(
  uri: string,
): Promise<{ uri: string; width?: number; height?: number } | null> {
  if (typeof document === 'undefined') return null;
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    const fail = () => resolve(null);
    video.onerror = fail;
    video.onloadeddata = () => {
      // Un instante dentro del video: el fotograma 0 de muchas camaras es negro.
      video.currentTime = Math.min(0.1, video.duration || 0.1);
    };
    video.onseeked = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx || !canvas.width || !canvas.height) return fail();
        ctx.drawImage(video, 0, 0);
        canvas.toBlob(
          (blob) => {
            if (!blob) return fail();
            resolve({
              uri: URL.createObjectURL(blob),
              width: canvas.width,
              height: canvas.height,
            });
          },
          'image/jpeg',
          0.8,
        );
      } catch {
        // Un video de otro origen sin CORS "ensucia" el canvas y toBlob lanza.
        fail();
      }
    };
    video.src = uri;
  });
}
