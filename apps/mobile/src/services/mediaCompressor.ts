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

type CompressorModule = {
  Image: { compress: (uri: string, options?: unknown) => Promise<string> };
  Video: {
    compress: (
      uri: string,
      options: unknown,
      onProgress?: (progress: number) => void,
    ) => Promise<string>;
  };
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

/** Comprime un video. Devuelve la ruta local del resultado. */
export async function compressVideo(
  uri: string,
  onProgress?: (ratio: number) => void,
): Promise<string> {
  if (!native) return uri;
  return native.Video.compress(uri, { compressionMethod: 'auto' }, (progress) =>
    onProgress?.(progress),
  );
}

/** Comprime una imagen. Devuelve la ruta local del resultado. */
export async function compressImage(uri: string): Promise<string> {
  if (!native) return uri;
  return native.Image.compress(uri, { compressionMethod: 'auto' });
}
