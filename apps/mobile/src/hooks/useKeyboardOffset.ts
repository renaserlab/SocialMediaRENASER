import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { APP_HEADER_HEIGHT } from '@/components/AppHeader';

/**
 * Desplazamiento que necesita `KeyboardAvoidingView` cuando el contenido va
 * debajo de un `AppHeader`: el KAV mide desde el borde superior de la ventana,
 * asi que hay que descontar la altura real del header (alto fijo + inset).
 *
 * Centralizarlo evita numeros magicos que se desincronizan al cambiar el header.
 */
export function useKeyboardOffset() {
  const insets = useSafeAreaInsets();
  return APP_HEADER_HEIGHT + insets.top;
}
