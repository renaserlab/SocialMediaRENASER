import { Alert, Platform } from 'react-native';

/**
 * Aviso multiplataforma.
 *
 * `Alert.alert` no esta implementado en react-native-web (es un no-op silencioso),
 * asi que en web caemos a `window.alert`. Gemelo de `confirm()`, para avisos de un
 * solo boton.
 */
export function notify(title: string, message?: string): void {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') {
      window.alert(message ? `${title}\n\n${message}` : title);
    }
    return;
  }

  Alert.alert(title, message);
}
