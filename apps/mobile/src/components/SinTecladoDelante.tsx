import {
  PropsWithChildren,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { KeyboardAvoidingView, Platform, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';

import { useTeclado } from '@/components/teclado';
import { huecoDelMarco, rellenoInferior } from '@/lib/huecoDelTeclado';

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
 * y hay que apartar el contenido desde aqui. Dos fallos vistos en telefono
 * explican como esta hecho:
 *
 *   · 06/10/2026, el hueco al CERRAR el teclado. `KeyboardAvoidingView` con
 *     `height` hacia al ocultarse la misma resta que al mostrarse, con un
 *     numero que en una ventana de borde a borde no es la posicion del teclado,
 *     y se quedaba encogido lo que miden las barras del sistema. Aqui, sin
 *     teclado el hueco es CERO sin hacer ninguna cuenta.
 *
 *   · 06–07/10/2026, el campo MEDIO TAPADO en el directo, en los comentarios y
 *     al publicar. En Android 11 o superior React Native solo avisa cuando el
 *     teclado aparece o desaparece, no cuando CAMBIA DE ALTO: al empezar a
 *     escribir sale la fila de sugerencias, el teclado crece y nadie se entera.
 *     Por eso el alto no sale solo de ese aviso: `ProveedorDelTeclado` sigue
 *     ademas el alto real en los margenes de la ventana. Como se combinan los
 *     dos datos lo decide `lib/huecoDelTeclado`.
 *
 * DONDE PONERLO: envolviendo el contenido de la pantalla, al mismo nivel que el
 * `AppHeader` o justo debajo. Nunca dentro de un elemento de una lista.
 * `AppScreen` ya lo trae puesto: una pantalla hecha con el no tiene que
 * acordarse.
 *
 * UNO DENTRO DE OTRO: APARTA EL DE MAS ADENTRO. `AppScreen` lo trae de
 * fabrica y hay pantallas que ademas ponen el suyo, mas cerca del campo y con
 * su propio relleno. Si apartaran los dos, el contenido subiria el doble. El
 * de dentro se apunta en el de fuera al montarse, y el de fuera cede mientras
 * tenga alguno apuntado: el que mejor conoce el sitio es el que esta mas cerca.
 */
type Props = PropsWithChildren<{
  style?: StyleProp<ViewStyle>;
  /** Apagarlo mientras la pantalla no escribe (p. ej. un modal cerrado). */
  enabled?: boolean;
  /**
   * Este marco vive en OTRA ventana —un `Modal`—. Lo que aparte la pantalla
   * que hay debajo no le sirve, y el no debe hacerla ceder: no se apunta en
   * ningun marco de fuera.
   */
  ventanaPropia?: boolean;
}>;

/** Donde se apuntan los marcos que hay dentro de otro. */
type Nido = { anidar: () => () => void };
const NidoDeApartados = createContext<Nido | null>(null);

export function SinTecladoDelante({ children, style, enabled = true, ventanaPropia = false }: Props) {
  const deFuera = useContext(NidoDeApartados);
  const [anidados, setAnidados] = useState(0);
  const propio = useMemo<Nido>(
    () => ({
      anidar: () => {
        setAnidados((n) => n + 1);
        return () => setAnidados((n) => n - 1);
      },
    }),
    [],
  );

  // Apagado no cuenta: un marco que no aparta no puede hacer ceder a otro.
  useEffect(() => {
    if (!enabled || ventanaPropia || !deFuera) return;
    return deFuera.anidar();
  }, [deFuera, enabled, ventanaPropia]);

  const aparta = enabled && anidados === 0;

  return (
    <NidoDeApartados.Provider value={propio}>
      {Platform.OS === 'android' ? (
        <ApartadoEnAndroid style={style} enabled={aparta}>
          {children}
        </ApartadoEnAndroid>
      ) : (
        <KeyboardAvoidingView
          style={[{ flex: 1 }, style]}
          // En la web no hay teclado que apartar: sin `behavior` no hace nada.
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
          enabled={aparta}
        >
          {children}
        </KeyboardAvoidingView>
      )}
    </NidoDeApartados.Provider>
  );
}

/** El relleno inferior que la pantalla ya le pone al marco, si le pone alguno. */
function rellenoDeLaPantalla(style: StyleProp<ViewStyle>): number {
  const plano = StyleSheet.flatten(style);
  const relleno = plano?.paddingBottom ?? plano?.paddingVertical ?? plano?.padding;
  return typeof relleno === 'number' ? relleno : 0;
}

/**
 * El marco que se aparta del teclado en Android.
 *
 * EL MARCO SE MIDE A SI MISMO, Y EL TECLADO LO MIDE OTRO. Aqui solo se sabe
 * donde acaba este marco en la ventana; que hace el teclado lo dice
 * `useTeclado()`. El hueco es la resta, y se recalcula solo cada vez que
 * cambia cualquiera de los dos: no hay nada que «recordar» de la ultima vez
 * que se abrio el teclado, que es de donde salian los huecos que se quedaban
 * puestos.
 *
 * EL HUECO ES RELLENO, NO ALTURA. El marco no cambia de tamano —sigue siendo
 * `flex: 1`—, asi que su borde inferior no se mueve al apartarse y la medida no
 * depende de lo que ella misma acaba de cambiar.
 */
function ApartadoEnAndroid({
  children,
  style,
  enabled,
}: PropsWithChildren<{ style?: StyleProp<ViewStyle>; enabled: boolean }>) {
  const teclado = useTeclado();
  const marco = useRef<View>(null);
  /** Donde acaba este marco en la ventana. `null` hasta la primera medida. */
  const [bordeInferior, setBordeInferior] = useState<number | null>(null);

  const medir = useCallback(() => {
    marco.current?.measureInWindow((_x, y, _ancho, alto) => {
      const borde = y + alto;
      if (!Number.isFinite(borde)) return;
      // Mismo numero, mismo estado: medir no repinta si nada se ha movido.
      setBordeInferior((previo) => (previo !== null && Math.abs(previo - borde) < 0.5 ? previo : borde));
    });
  }, []);

  /*
    Se vuelve a medir cuando el teclado aparece. `onLayout` solo avisa si
    cambia el recuadro de ESTE marco respecto a su padre; si lo que se movio fue
    algo de mas arriba, la medida guardada seria la de antes.
  */
  const tecladoALaVista = teclado.visible || teclado.altoAsentado > 0;
  useEffect(() => {
    if (tecladoALaVista) medir();
  }, [tecladoALaVista, medir]);

  const hueco = enabled ? huecoDelMarco(bordeInferior, teclado) : 0;
  const relleno = rellenoInferior(hueco, rellenoDeLaPantalla(style));

  return (
    <View
      ref={marco}
      // Sin esto Android puede fundir esta vista con su padre, y no habria
      // nada que medir.
      collapsable={false}
      onLayout={medir}
      style={[{ flex: 1 }, style, relleno !== null ? { paddingBottom: relleno } : null]}
    >
      {children}
    </View>
  );
}
