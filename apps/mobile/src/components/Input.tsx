import React, { useEffect, useRef, useState } from 'react';
import {
  Platform,
  StyleSheet,
  TextInput,
  TextInputProps,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Feather from '@expo/vector-icons/Feather';

import { Text } from '@/components/Text';
import { AMPLITUD_DE_SACUDIDA, DURACION } from '@/lib/movimiento';
import { getTextStyle, palette, radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type InputProps = TextInputProps & {
  label?: string;
  error?: string;
  disabled?: boolean;
  containerStyle?: ViewStyle;
  /**
   * `pastilla` para los redactores (chat, comentarios): los extremos
   * redondos y un fondo suave lo distinguen de un campo de formulario, que es
   * una `caja`. `destacada` es la caja de las pantallas donde el campo ES la
   * pantalla (entrar, crear la cuenta): más alta, con fondo y letra de 16.
   * Mismo componente, mismo foco, mismo error.
   */
  forma?: 'caja' | 'pastilla' | 'destacada';
  /** Un icono dentro del campo, a la izquierda: dice qué se escribe ahí. */
  icono?: keyof typeof Feather.glyphMap;
  /** Algo dentro del campo, a la derecha: el ojo de una contraseña. */
  accesorio?: React.ReactNode;
  /** Para llevar el foco a este campo desde el anterior («siguiente» en el teclado). */
  campoRef?: React.Ref<TextInput>;
};

/*
  EL AUTORRELLENO DEL NAVEGADOR.

  Cuando Chrome o Edge rellenan un campo con un dato guardado le pintan su
  propio fondo azul claro y su propio color de letra, con `!important`. Sobre el
  tema negro salía un bloque celeste en mitad del formulario, y la letra del
  navegador no tiene por qué leerse sobre nuestro fondo.

  Ese fondo no se puede sobrescribir, pero sí retrasar: una transición
  larguísima hace que no llegue a pintarse. La letra se fija por tema, y solo en
  ese estado, para no tocar el color del texto de ejemplo.

  Solo existe en web; en el teléfono no hay nada que corregir.
*/
const ID_ESTILO = 'estilo-campo-autorrelleno';
if (Platform.OS === 'web' && typeof document !== 'undefined' && !document.getElementById(ID_ESTILO)) {
  const reglaDeTinta = (modo: 'light' | 'dark') => {
    const tinta = palette(modo).text;
    return `input[data-campo="${modo}"]:-webkit-autofill { -webkit-text-fill-color: ${tinta}; caret-color: ${tinta}; }`;
  };
  const estilo = document.createElement('style');
  estilo.id = ID_ESTILO;
  estilo.textContent = `
input[data-campo]:-webkit-autofill,
input[data-campo]:-webkit-autofill:hover,
input[data-campo]:-webkit-autofill:focus { transition: background-color 100000s ease-in-out 0s; }
${reglaDeTinta('light')}
${reglaDeTinta('dark')}
`;
  document.head.appendChild(estilo);
}

/** La marca que lee la regla de arriba. `dataSet` solo existe en web. */
function marcaDeCampo(modo: string): any {
  return Platform.OS === 'web' ? { dataSet: { campo: modo } } : {};
}

/*
  EL ANILLO DE FOCO DEL NAVEGADOR.

  En web el navegador dibuja su propio anillo DENTRO de la caja, que ya cambia
  de borde al enfocarse: se veían dos marcos, uno dentro del otro. El foco lo
  sigue diciendo la caja.

  Tiene que ser el ESTILO a `none`: el anillo del navegador es `outline: auto`,
  y con `auto` el grosor se ignora, así que ponerlo a cero no lo quita. React
  Native no tipa `none` (en el teléfono no existe), de ahí la conversión.
*/
const SIN_ANILLO_DEL_NAVEGADOR =
  Platform.OS === 'web' ? ({ outlineStyle: 'none' } as unknown as TextStyle) : null;

export function Input({
  label,
  error,
  disabled = false,
  containerStyle,
  forma = 'caja',
  icono,
  accesorio,
  campoRef,
  onFocus,
  onBlur,
  style,
  ...props
}: InputProps) {
  const { colors, mode } = useAppTheme();
  const [focused, setFocused] = useState(false);
  const destacada = forma === 'destacada';

  /*
    EL CAMPO DICE QUE NO.

    Al aparecer un error el campo se mueve un instante a los lados. El texto
    del error sigue ahí debajo, con su icono: el gesto solo lleva la vista al
    campo que hay que corregir, que en un formulario de tres no siempre es el
    que se estaba mirando.

    Solo cuando el error APARECE —no al montarse con uno ya puesto ni mientras
    cambia de texto— y nunca con «reducir movimiento».
  */
  const reducir = useReducedMotion();
  const desplazamiento = useSharedValue(0);
  const habiaError = useRef(Boolean(error));
  useEffect(() => {
    const hay = Boolean(error);
    if (hay && !habiaError.current && !reducir) {
      const paso = DURACION.normal / 4;
      desplazamiento.value = withSequence(
        withTiming(-AMPLITUD_DE_SACUDIDA, { duration: paso }),
        withTiming(AMPLITUD_DE_SACUDIDA, { duration: paso }),
        withTiming(-AMPLITUD_DE_SACUDIDA / 2, { duration: paso }),
        withTiming(0, { duration: paso }),
      );
    }
    habiaError.current = hay;
  }, [error, reducir, desplazamiento]);
  const sacudida = useAnimatedStyle(() => ({
    transform: [{ translateX: desplazamiento.value }],
  }));

  const tintaDelIcono = error ? colors.danger : focused ? colors.text : colors.textMuted;

  return (
    <View style={[styles.container, containerStyle]}>
      {label && (
        <Text
          style={[
            styles.label,
            destacada && styles.labelDestacada,
            { color: error ? colors.danger : colors.textMuted },
          ]}
        >
          {label}
        </Text>
      )}
      <Animated.View
        style={[
          styles.inputWrapper,
          forma === 'pastilla' && styles.pastilla,
          destacada && styles.destacada,
          {
            borderColor: error ? colors.danger : focused ? colors.primary : colors.border,
            backgroundColor: forma === 'caja' ? colors.background : colors.surfaceAlt,
            opacity: disabled ? 0.5 : 1,
          },
          // El foco no vive solo en el color del borde: un halo alrededor.
          destacada && focused && !error ? { boxShadow: `0 0 0 3px ${colors.glassActive}` } : null,
          sacudida,
        ]}
      >
        {icono ? <Feather name={icono} size={18} color={tintaDelIcono} /> : null}
        <TextInput
          ref={campoRef}
          editable={!disabled}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          placeholderTextColor={colors.textMuted}
          style={[
            styles.input,
            destacada && styles.inputDestacado,
            SIN_ANILLO_DEL_NAVEGADOR,
            { color: colors.text },
            style,
          ]}
          accessibilityLabel={label || props.placeholder}
          {...marcaDeCampo(mode)}
          {...props}
        />
        {accesorio}
      </Animated.View>
      {error && (
        <View style={styles.errorContainer} accessibilityRole="alert" accessibilityLiveRegion="polite">
          <Feather name="alert-circle" size={14} color={colors.danger} />
          <Text style={[styles.errorText, { color: colors.danger }]}>{error}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.xs,
    width: '100%',
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
  },
  labelDestacada: {
    fontSize: 13,
  },
  inputWrapper: {
    minHeight: 48,
    borderRadius: radius.sm,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    // En fila: el icono, el campo y el accesorio comparten la caja. Sin icono
    // ni accesorio el campo la ocupa entera, igual que antes.
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  pastilla: {
    borderRadius: 22,
    paddingHorizontal: spacing.lg,
  },
  destacada: {
    minHeight: 54,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
  },
  input: {
    // La letra de la aplicación. Sin esto lo escrito salía con la del sistema
    // —distinta de la etiqueta que tiene encima— y, en Android, un campo de
    // contraseña cambiaba de letra al mostrarla y ocultarla.
    ...getTextStyle('400'),
    flex: 1,
    // Sin esto, en web un campo no encoge por debajo de su ancho natural y
    // empuja al accesorio fuera de la caja.
    minWidth: 0,
    fontSize: 14,
    padding: 0,
    minHeight: 44,
  },
  inputDestacado: {
    // 16 y no 14: es lo que evita que Safari amplíe la página al enfocar.
    fontSize: 16,
  },
  errorContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  errorText: {
    fontSize: 12,
    fontWeight: '500',
  },
});
