import { Platform } from 'react-native';

/**
 * El fundido con el que el `Image` de React Native enseña una foto: 300 ms en
 * Android (`fadeDuration` por defecto) y ninguno en iOS ni en la web.
 *
 * `expo-image` no funde salvo que se le pida. Lo usan las imágenes que pasaron
 * de un componente al otro para tener la cache por ruta de Storage, y así
 * siguen apareciendo exactamente igual que antes en cada plataforma. Un 300 a
 * secas añadiría en iOS y en la web un fundido que allí nunca hubo.
 */
export const FUNDIDO_DEL_IMAGE_DE_REACT_NATIVE = Platform.OS === 'android' ? 300 : 0;
