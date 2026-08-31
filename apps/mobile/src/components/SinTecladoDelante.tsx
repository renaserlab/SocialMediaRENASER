import { PropsWithChildren } from 'react';
import { KeyboardAvoidingView, Platform, StyleProp, ViewStyle } from 'react-native';

/**
 * Lo que se escribe no puede quedar debajo del teclado. UN solo sitio.
 *
 * COMO FUNCIONA `KeyboardAvoidingView` (y por que antes fallaba):
 *
 * Mide su propio recuadro con `onLayout` —cuya `y` es RELATIVA a su padre— y le
 * resta la posicion del teclado en coordenadas de PANTALLA. La cuenta solo
 * cuadra cuando la cadena de padres arranca en el borde superior de la ventana,
 * que es el caso de todas las pantallas de esta aplicacion: la raiz es un
 * `<View style={{flex:1}}>` y el `AppHeader` es un hermano DENTRO del arbol
 * (`headerShown: false` en el Stack).
 *
 * Por eso aqui `keyboardVerticalOffset` es CERO y no se ofrece como propiedad.
 * El offset existe para la otra situacion —la cabecera nativa de un navegador,
 * que vive FUERA del arbol de React y no entra en la medida—. Al pasarlo
 * tambien aqui se descontaba dos veces la altura de la cabecera y el contenido
 * subia de mas: quedaba un hueco entre el campo y el teclado, y en Android el
 * contenedor se encogia ~100 px de mas. Ese era el «numero magico» heredado.
 *
 * POR QUE `padding` EN iOS Y `height` EN ANDROID. En Android la aplicacion es
 * `edgeToEdgeEnabled`, asi que la ventana NO se reajusta al abrirse el teclado
 * (`adjustResize` deja de tener efecto): hay que encoger el contenedor a mano,
 * que es justo lo que hace `height`. Dejar `behavior` sin valor —como estaba en
 * Comentarios y en la emision en vivo— significa NO HACER NADA en Android, y de
 * ahi que alli el teclado tapara literalmente el campo.
 *
 * DONDE PONERLO: envolviendo el contenido de la pantalla, al mismo nivel que el
 * `AppHeader` o justo debajo. Nunca dentro de un elemento de una lista.
 */
type Props = PropsWithChildren<{
  style?: StyleProp<ViewStyle>;
  /** Apagarlo mientras la pantalla no escribe (p. ej. un modal cerrado). */
  enabled?: boolean;
}>;

export function SinTecladoDelante({ children, style, enabled = true }: Props) {
  return (
    <KeyboardAvoidingView
      style={[{ flex: 1 }, style]}
      behavior={Platform.select({ ios: 'padding', android: 'height' })}
      keyboardVerticalOffset={0}
      enabled={enabled}
    >
      {children}
    </KeyboardAvoidingView>
  );
}
