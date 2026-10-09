import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { palette, radius, spacing } from '@/theme/tokens';

/**
 * CONTRASTE PARA EL TEXTO QUE VA ENCIMA DE UNA FOTO O UN VIDEO.
 *
 * EL PROBLEMA REAL NO ES EL COLOR DEL TEXTO. Encima de un medio no hay ningun
 * color de letra que funcione: la foto puede ser negra, blanca o mitad y mitad,
 * y cualquier color elegido sera ilegible sobre la mitad que se le parezca. Por
 * eso «Se verá durante 24 horas» y el aviso de «Subiendo… / Cancelar»
 * desaparecian: estaban escritos en blanco directamente sobre la imagen.
 *
 * LO QUE SI LO ARREGLA es poner algo DETRAS del texto. Aqui hay las dos formas
 * de hacerlo, y las dos oscurecen el MEDIO, no el tema:
 *
 *   - `ScrimDeMedio`: un degradado que apaga la franja donde se apoya el pie.
 *   - `SuperficieSobreMedio`: una superficie opaca para un bloque concreto.
 *
 * SOBRE UN MEDIO EL CONTEXTO ES OSCURO EN LOS DOS TEMAS. Una historia a
 * pantalla completa se ve igual con la aplicacion en claro que en oscuro, asi
 * que el contraste NO se calcula con el tema de la persona sino con la paleta
 * oscura: es lo que ya hacen `ModoHistoria`, `ModoReel` y `ModoPublicacion`.
 * Cambiarlo con el tema es justo lo que produciria texto negro sobre un video
 * oscuro cuando alguien tiene la aplicacion en claro.
 */

/** La paleta con la que se pinta cualquier cosa que vaya encima de un medio. */
export const sobreMedio = palette('dark');

/**
 * Un RELLENO rojo con letra encima: «EN VIVO», «Terminar».
 *
 * `danger` de la paleta oscura es un rojo CLARO, pensado para ser
 * letra o icono sobre negro. Usado como fondo con letra blanca encima se queda
 * en 2,3 a 1: «EN VIVO» y «Terminar» se leian mal, y son justo los dos rotulos
 * que no pueden fallar en la sala. El rojo que si aguanta letra blanca es el de
 * la paleta clara (6,5 a 1), y ya existe: no se inventa ningun color.
 *
 * Es opaco, asi que no depende de lo que haya detras —el video, una foto—.
 */
export const rellenoDePeligro = {
  fondo: palette('light').danger,
  texto: palette('light').onPrimary,
} as const;

/*
  Los degradados salen de los tokens: `overlay` es el mismo velo que usan los
  fondos de la aplicacion. Aqui no se escribe ningun color a mano.
*/
const HACIA_ABAJO = ['transparent', sobreMedio.overlay] as const;
const HACIA_ARRIBA = [sobreMedio.overlay, 'transparent'] as const;

/** Alto por defecto de la franja apagada. Cubre un pie con boton y avisos. */
const ALTO_POR_DEFECTO = 280;

type ScrimProps = {
  /** Donde se apoya el degradado. `abajo` es el pie; `arriba`, la cabecera. */
  borde?: 'abajo' | 'arriba';
  /** Cuanto ocupa la franja. Ajustalo al alto real del contenido. */
  alto?: number;
  style?: StyleProp<ViewStyle>;
};

/**
 * Apaga la franja del medio donde se apoya el contenido.
 *
 * NO CAPTURA TOQUES (`pointerEvents="none"`): esta por delante del video y por
 * detras de los botones, y si se los quedara no se podria pulsar nada.
 */
export function ScrimDeMedio({ borde = 'abajo', alto = ALTO_POR_DEFECTO, style }: ScrimProps) {
  return (
    <LinearGradient
      pointerEvents="none"
      colors={borde === 'abajo' ? HACIA_ABAJO : HACIA_ARRIBA}
      style={[styles.scrim, borde === 'abajo' ? { bottom: 0 } : { top: 0 }, { height: alto }, style]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}

type SuperficieProps = {
  children: React.ReactNode;
  /** `pildora` para una linea suelta; `caja` para un bloque con varias. */
  forma?: 'caja' | 'pildora';
  style?: StyleProp<ViewStyle>;
};

/**
 * Superficie de alto contraste para un bloque de texto sobre un medio.
 *
 * Se usa ADEMAS del scrim, no en su lugar: apilada sobre el degradado deja el
 * fondo practicamente opaco, que es lo que garantiza la lectura tambien sobre
 * una foto blanca.
 */
export function SuperficieSobreMedio({ children, forma = 'caja', style }: SuperficieProps) {
  return (
    <View
      style={[
        styles.superficie,
        forma === 'pildora' ? styles.pildora : styles.caja,
        style,
      ]}
    >
      {children}
    </View>
  );
}

/**
 * Sombra para el texto que NO puede llevar superficie detras (por ejemplo, el
 * que va encima de la camara en vivo). Es un refuerzo, nunca el unico recurso.
 */
export const SOMBRA_DE_TEXTO = {
  textShadowColor: sobreMedio.background,
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 4,
} as const;

const styles = StyleSheet.create({
  scrim: { position: 'absolute', left: 0, right: 0 },
  superficie: {
    backgroundColor: sobreMedio.overlay,
    borderWidth: 1,
    borderColor: sobreMedio.glassBorder,
  },
  caja: { borderRadius: radius.lg, padding: spacing.md, gap: spacing.xs },
  pildora: {
    borderRadius: radius.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
});
