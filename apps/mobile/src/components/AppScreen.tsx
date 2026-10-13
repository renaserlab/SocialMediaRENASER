import { PropsWithChildren } from 'react';
import { ScrollView, ScrollViewProps, StyleProp, View, ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ReservaDeZonaSegura, useDentroDeLasPestanas } from '@/components/espacioInferior';
import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { useTecladoALaVista } from '@/components/teclado';
import { useAppTheme } from '@/theme/useAppTheme';

type Borde = 'top' | 'right' | 'bottom' | 'left';

type AppScreenProps = PropsWithChildren<{
  scroll?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  edges?: Borde[];
  scrollProps?: ScrollViewProps;
  /**
   * Que el teclado no tape lo que se escribe. VIENE DE FABRICA.
   *
   * Antes habia que pedirlo, y 49 pantallas con campos no lo pedian (auditado
   * el 07/10/2026): al escribir en el ultimo campo de un formulario, el
   * teclado lo tapaba. Se podia dejar apagado de fabrica porque dos
   * `SinTecladoDelante` anidados se encogian dos veces; ya no: cuando hay
   * uno dentro de otro aparta solo el de dentro.
   *
   * En una pantalla sin campos no hace nada: sin teclado no hay hueco.
   */
  teclado?: boolean;
}>;

/**
 * Los bordes que se respetan si la pantalla no dice otra cosa.
 *
 * ARRIBA NO: la mayoria de pantallas llevan <AppHeader/>, que ya lo respeta.
 * Las pantallas sin cabecera pasan `edges` con 'top' explicitamente.
 *
 * ABAJO SI, FUERA DE LAS PESTAÑAS. La aplicacion es `edgeToEdgeEnabled`: en
 * Android se pinta por debajo de los botones del sistema (atras, inicio,
 * recientes). Hasta el 25/09/2026 el valor por defecto era solo izquierda y
 * derecha, y lo ultimo de cada pantalla —«Postula tu producto» en Mis
 * productos, «Ver mis pedidos» en la bolsa, el ultimo elemento de cualquier
 * lista— quedaba debajo de esos botones, sin poder pulsarse. Pasaba en las
 * cien pantallas que usan este contenedor a la vez, y se notaba sobre todo con
 * la navegacion de tres botones, que es la mas alta.
 *
 * Dentro de las pestañas NO: ahi la capsula flotante ya aparta la zona segura,
 * y cada pantalla deja sitio a la capsula con `useEspacioInferior()`.
 */
function bordesPorOmision(dentroDeLasPestanas: boolean): Borde[] {
  return dentroDeLasPestanas ? ['left', 'right'] : ['left', 'right', 'bottom'];
}

export function AppScreen({
  children,
  scroll = true,
  contentStyle,
  edges,
  scrollProps,
  teclado = true,
}: AppScreenProps) {
  const { colors } = useAppTheme();
  const dentroDeLasPestanas = useDentroDeLasPestanas();
  const bordes = edges ?? bordesPorOmision(dentroDeLasPestanas);
  /*
    CON EL TECLADO ABIERTO NO SE RESERVA EL BORDE INFERIOR. El marco de
    fuera ya deja el contenido justo encima del teclado, que es quien ocupa
    esa franja: reservarla además dejaba una banda vacía entre el formulario
    y el teclado. Solo cuando este componente pone el marco.
  */
  const tecladoAbierto = useTecladoALaVista();
  const bordesAhora =
    teclado && tecladoAbierto ? bordes.filter((borde) => borde !== 'bottom') : bordes;

  const pantalla = (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={bordesAhora}>
      {scroll ? (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[{ flexGrow: 1 }, contentStyle]}
          {...scrollProps}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1 }, contentStyle]}>{children}</View>
      )}
    </SafeAreaView>
  );
  const contenido = teclado ? <SinTecladoDelante>{pantalla}</SinTecladoDelante> : pantalla;

  // Lo de dentro ya no empieza en el canto: que `useEspacioInferior()` no
  // vuelva a sumar la zona segura.
  return bordes.includes('bottom') ? <ReservaDeZonaSegura>{contenido}</ReservaDeZonaSegura> : contenido;
}
