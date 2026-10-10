import { Linking, Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library';

import { extensionDe } from '@/lib/tiposDeArchivo';

/** Qué pasó al intentar guardar. La pantalla lo traduce a un aviso. */
export type ResultadoDeGuardar = 'guardado' | 'sin_permiso' | 'abierto_fuera' | 'fallo';

/**
 * Guarda en la galería del teléfono una foto o un vídeo del chat.
 *
 * El archivo vive en un almacén privado: se baja primero a la carpeta temporal
 * de la aplicación con su dirección firmada, y de ahí pasa a la galería.
 *
 * EN LA WEB no hay galería: se abre la dirección y el navegador ofrece
 * guardarla. Devuelve `abierto_fuera` para que la pantalla no diga «guardado».
 *
 * NUNCA LANZA: un fallo de red o de permisos vuelve como resultado.
 */
export async function guardarEnLaGaleria(
  url: string,
  nombre: string | null | undefined,
  tipo: 'image' | 'video',
): Promise<ResultadoDeGuardar> {
  try {
    if (Platform.OS === 'web') {
      await Linking.openURL(url);
      return 'abierto_fuera';
    }
    // Solo permiso de ESCRIBIR: para guardar una foto no hace falta leer la galería.
    const permiso = await MediaLibrary.requestPermissionsAsync(true);
    if (!permiso.granted) return 'sin_permiso';

    const legacy = await import('expo-file-system/legacy');
    const carpeta = legacy.cacheDirectory;
    if (!carpeta) return 'fallo';
    const ext = extensionDe(nombre) || (tipo === 'video' ? 'mp4' : 'jpg');
    const destino = `${carpeta}z-${Date.now()}.${ext}`;
    const bajado = await legacy.downloadAsync(url, destino);
    if (bajado.status < 200 || bajado.status >= 300) return 'fallo';

    await MediaLibrary.saveToLibraryAsync(bajado.uri);
    // La copia temporal ya no hace falta; si no se puede borrar, no pasa nada.
    await legacy.deleteAsync(bajado.uri, { idempotent: true }).catch(() => {});
    return 'guardado';
  } catch {
    return 'fallo';
  }
}
