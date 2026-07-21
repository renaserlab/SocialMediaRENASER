import { Image, Video } from 'react-native-compressor';

/**
 * Compresion en el dispositivo antes de subir, que es lo que hacen TikTok o
 * Instagram: un video de galeria de 100 MB suele quedar en 10-20 MB sin
 * diferencia visible en un feed. Ahorra datos del usuario y tiempo de subida.
 */
export const compressionAvailable = true;

/** Comprime un video. Devuelve la ruta local del resultado. */
export async function compressVideo(
  uri: string,
  onProgress?: (ratio: number) => void,
): Promise<string> {
  return Video.compress(uri, { compressionMethod: 'auto' }, (progress) =>
    onProgress?.(progress),
  );
}

/** Comprime una imagen. Devuelve la ruta local del resultado. */
export async function compressImage(uri: string): Promise<string> {
  return Image.compress(uri, { compressionMethod: 'auto' });
}
