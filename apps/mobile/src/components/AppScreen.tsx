import { PropsWithChildren } from 'react';
import { ScrollView, ScrollViewProps, StyleProp, View, ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ReservaDeZonaSegura, useDentroDeLasPestanas } from '@/components/espacioInferior';
import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { useAppTheme } from '@/theme/useAppTheme';

type Borde = 'top' | 'right' | 'bottom' | 'left';

type AppScreenProps = PropsWithChildren<{
  scroll?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  edges?: Borde[];
  scrollProps?: ScrollViewProps;
  /**
   * La pantalla tiene campos donde se escribe: que el teclado no los tape.
   * Se pide, no viene de fabrica, porque una pantalla que ya lleva su propio
   * `SinTecladoDelante` se encogeria dos veces.
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
  teclado = false,
}: AppScreenProps) {
  const { colors } = useAppTheme();
  const dentroDeLasPestanas = useDentroDeLasPestanas();
  const bordes = edges ?? bordesPorOmision(dentroDeLasPestanas);

  const pantalla = (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={bordes}>
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
