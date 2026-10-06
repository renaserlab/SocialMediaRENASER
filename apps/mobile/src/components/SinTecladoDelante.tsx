import { PropsWithChildren, useEffect, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, StyleProp, View, ViewStyle } from 'react-native';

import { huecoParaElTeclado } from '@/lib/huecoDelTeclado';

/**
 * Lo que se escribe no puede quedar debajo del teclado. UN solo sitio.
 *
 * EN iOS, `KeyboardAvoidingView` con `padding`. Mide su propio recuadro con
 * `onLayout` —cuya `y` es RELATIVA a su padre— y le resta la posicion del
 * teclado en coordenadas de PANTALLA. La cuenta solo cuadra cuando la cadena de
 * padres arranca en el borde superior de la ventana, que es el caso de todas
 * las pantallas de esta aplicacion: la raiz es un `<View style={{flex:1}}>` y
 * el `AppHeader` es un hermano DENTRO del arbol (`headerShown: false` en el
 * Stack). Por eso `keyboardVerticalOffset` es CERO y no se ofrece como
 * propiedad: pasarlo descontaba dos veces la cabecera y dejaba un hueco entre
 * el campo y el teclado.
 *
 * EN ANDROID, A MANO (`ApartadoEnAndroid`). La aplicacion es
 * `edgeToEdgeEnabled`, asi que la ventana NO se reajusta al abrirse el teclado
 * y hay que apartar el contenido desde aqui. Antes lo hacia el mismo
 * `KeyboardAvoidingView`, con `height`, y dejaba un fallo a la vista (visto en
 * telefono el 06/10/2026): al CERRAR el teclado —con el boton de atras, por
 * ejemplo— el redactor del chat no volvia a su sitio y quedaba un hueco debajo.
 *
 * LA CAUSA, leida en React Native 0.81. Al ocultarse, Android manda en
 * `keyboardDidHide` la ALTURA del area visible como si fuera la posicion del
 * teclado, y esa area no cuenta la barra de estado ni la de navegacion. Con
 * `height`, el componente hace con ese numero la misma resta que al mostrarse:
 * en una ventana de borde a borde le sale que el teclado «sigue tapando» justo
 * lo que miden esas dos barras, y se queda encogido esa cantidad. No es un
 * caso raro: pasa siempre que se cierra el teclado.
 *
 * Aqui, al ocultarse, el hueco es CERO, sin hacer ninguna cuenta.
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
  if (Platform.OS === 'android') {
    return (
      <ApartadoEnAndroid style={style} enabled={enabled}>
        {children}
      </ApartadoEnAndroid>
    );
  }
  return (
    <KeyboardAvoidingView
      style={[{ flex: 1 }, style]}
      // En la web no hay teclado que apartar: sin `behavior` no hace nada.
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
      enabled={enabled}
    >
      {children}
    </KeyboardAvoidingView>
  );
}

/**
 * El marco que se aparta del teclado en Android.
 *
 * AL MOSTRARSE se mide donde acaba este marco en la ventana y se le resta
 * donde empieza el teclado: lo que sobra es el hueco. Es la misma cuenta que
 * hacia `KeyboardAvoidingView`, asi que el campo queda donde quedaba.
 *
 * EL HUECO ES RELLENO, NO ALTURA. El marco no cambia de tamano —sigue siendo
 * `flex: 1`—, asi que su borde inferior no se mueve al apartarse y la medida no
 * depende de lo que ella misma acaba de cambiar.
 *
 * AL OCULTARSE, cero. Ver arriba por que no se calcula.
 */
function ApartadoEnAndroid({ children, style, enabled }: Required<Pick<Props, 'enabled'>> & Props) {
  const marco = useRef<View>(null);
  const [hueco, setHueco] = useState(0);

  useEffect(() => {
    const apartarDe = (bordeDelTeclado: number) => {
      marco.current?.measureInWindow((_x, y, _ancho, alto) => {
        setHueco(huecoParaElTeclado(y + alto, bordeDelTeclado));
      });
    };
    const alMostrar = Keyboard.addListener('keyboardDidShow', (evento) => {
      apartarDe(evento.endCoordinates.screenY);
    });
    const alOcultar = Keyboard.addListener('keyboardDidHide', () => setHueco(0));

    // Se puede llegar a una pantalla con el teclado ya abierto: no habra
    // «se ha mostrado» que oir.
    if (Keyboard.isVisible()) {
      const teclado = Keyboard.metrics();
      if (teclado) apartarDe(teclado.screenY);
    }

    return () => {
      alMostrar.remove();
      alOcultar.remove();
    };
  }, []);

  return (
    <View
      ref={marco}
      // Sin esto Android puede fundir esta vista con su padre, y no habria
      // nada que medir.
      collapsable={false}
      style={[{ flex: 1 }, style, enabled && hueco > 0 ? { paddingBottom: hueco } : null]}
    >
      {children}
    </View>
  );
}
