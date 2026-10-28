import type { PickedMedia, UploadProgress } from '@/services/storage';

/** Lo que hay que subir, y como soltar la copia si se hizo una. */
export type FotoParaSubir = {
  /** La foto reducida, o el mismo medio que llego si no se toco. */
  media: PickedMedia;
  /** Libera la copia reducida. Se llama al terminar de subir, haya ido bien o mal. */
  liberar: () => void;
};

/**
 * Movil: no hace nada, y a proposito.
 *
 * Con la aplicacion instalada, `uploadPostMedia` ya pasa la foto por
 * `react-native-compressor`, que la deja en 1280 px a calidad 0,8; reducirla
 * aqui seria comprimirla dos veces. En Expo Go ese modulo no esta y no hay con
 * que sustituirlo sin una dependencia nueva: no viene `expo-image-manipulator`,
 * `expo-image` sabe cargar una imagen reducida pero no guardarla en un archivo,
 * y la opcion `scale` de la camara es solo para web. Alli se sigue subiendo el
 * original, como hasta ahora. La version web, que si reduce, esta en
 * `reducirFoto.web.ts`.
 */
export async function prepararFotoParaSubir(
  media: PickedMedia,
  _onProgress?: (progress: UploadProgress) => void,
): Promise<FotoParaSubir> {
  return { media, liberar: () => {} };
}
