import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  StyleProp,
  StyleSheet,
  TextInput,
  TextInputProps,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import { DURACION, ESCALA_AL_PULSAR, MUELLE } from '@/lib/movimiento';
import { getTextStyle, radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  value: string;
  onChangeText: (texto: string) => void;
  placeholder: string;
  /** Hay una búsqueda en vuelo: la lupa se convierte en un indicador. */
  buscando?: boolean;
  /** Lo que se anuncia del botón de borrar. */
  etiquetaDeLimpiar: string;
  /** Alto de la cápsula. 44 es el mínimo táctil; la bandeja usa 40. */
  alto?: number;
  style?: StyleProp<ViewStyle>;
  /** Para que la pantalla sepa si el campo tiene el foco. */
  alCambiarElFoco?: (enfocado: boolean) => void;
} & Pick<TextInputProps, 'onSubmitEditing' | 'autoFocus'>;

/** Hasta dónde se abre el hueco de «Cancelar». Sobra para los tres idiomas. */
const ANCHO_DE_CANCELAR = 96;

/*
  EL ANILLO DE FOCO DEL NAVEGADOR. En web el navegador dibujaba su propio marco
  DENTRO de la caja al enfocar: se veía un recuadro pequeño metido en el
  buscador (reportado el 04/10/2026). Tiene que ser el ESTILO a `none`: ese
  anillo es `outline: auto` y con `auto` el grosor se ignora. React Native no
  tipa `none` —en el teléfono no existe—, de ahí la conversión.
*/
const SIN_ANILLO_DEL_NAVEGADOR =
  Platform.OS === 'web' ? ({ outlineStyle: 'none' } as unknown as TextStyle) : null;

/**
 * El campo de búsqueda de la aplicación: el de Explorar y el de Mensajes.
 *
 * Eran dos campos escritos dos veces —una lupa, un `TextInput`, una X— que solo
 * cambiaban el color del borde al tocarlos. Aquí hay uno, y RESPONDE:
 *
 *   - AL ENFOCAR la lupa se enciende y salta un instante, el contorno apenas
 *     se insinúa y a la derecha se abre «Cancelar», que borra, quita el foco y
 *     cierra el teclado de un toque.
 *   - AL ESCRIBIR aparece la X, creciendo desde su centro.
 *   - MIENTRAS BUSCA la lupa se convierte en un indicador: se ve que la
 *     pregunta salió y que la respuesta está por llegar.
 *
 * LA LÓGICA NO VIVE AQUÍ. El antirrebote, el mínimo de caracteres y el sello
 * que descarta la respuesta de una consulta anterior siguen en
 * `lib/busquedaProgresiva` y en cada pantalla, donde ya estaban y ya estaban
 * probados. Esto es cómo se ve y cómo se siente.
 *
 * SIN SALTOS: el alto es fijo y el borde no cambia de grosor. «Cancelar» abre
 * su hueco animando el ancho; con «reducir movimiento» aparece de golpe.
 *
 * LA FORMA (04/10/2026). Era una cápsula con un borde de un punto que al
 * enfocar se volvía blanco: un marco dentro de otro marco, con aspecto de
 * formulario antiguo. Ahora es una caja RELLENA de esquinas suaves y sin
 * marco, como el buscador de cualquier bandeja actual: el relleno la separa del
 * fondo sin dibujar una línea. Enfocada, el contorno pasa de invisible a un
 * gris tenue —lo justo para quien navega con teclado— y nunca a un marco duro.
 */
export function CampoDeBusqueda({
  value,
  onChangeText,
  placeholder,
  buscando = false,
  etiquetaDeLimpiar,
  alto = 44,
  style,
  alCambiarElFoco,
  onSubmitEditing,
  autoFocus,
}: Props) {
  const { t } = useTranslation();
  const { colors, mode } = useAppTheme();
  const reducir = useReducedMotion();
  const campo = useRef<TextInput>(null);
  const [enfocado, setEnfocado] = useState(false);

  const foco = useSharedValue(0);
  const lupa = useSharedValue(1);
  const hayTexto = value.length > 0;
  // Nace en cero: la X se monta al escribir la primera letra y crece desde ahi.
  const equis = useSharedValue(0);

  useEffect(() => {
    const duracion = reducir ? 0 : DURACION.normal;
    foco.value = withTiming(enfocado ? 1 : 0, { duration: duracion });
    if (enfocado && !reducir) {
      lupa.value = 1.18;
      lupa.value = withSpring(1, MUELLE);
    }
  }, [enfocado, foco, lupa, reducir]);

  useEffect(() => {
    equis.value = reducir ? (hayTexto ? 1 : 0) : withSpring(hayTexto ? 1 : 0, MUELLE);
  }, [hayTexto, equis, reducir]);

  // En oscuro el gris de superficie (#111) se despega del negro; en claro el
  // que se despega del blanco es `surfaceAlt` (#F7F7F7).
  const relleno = mode === 'dark' ? colors.surface : colors.surfaceAlt;
  // Sin foco el contorno es del color del relleno: está, y no se ve.
  const sinFoco = relleno;
  const conFoco = colors.disabled;
  const borde = useAnimatedStyle(() => ({
    borderColor: interpolateColor(foco.value, [0, 1], [sinFoco, conFoco]),
  }));
  const lupaAnimada = useAnimatedStyle(() => ({ transform: [{ scale: lupa.value }] }));
  const equisAnimada = useAnimatedStyle(() => ({
    opacity: equis.value,
    transform: [{ scale: 0.6 + equis.value * 0.4 }],
  }));
  const cancelar = useAnimatedStyle(() => ({
    maxWidth: foco.value * ANCHO_DE_CANCELAR,
    opacity: foco.value,
    marginLeft: foco.value * spacing.sm,
  }));

  const cambiarFoco = (valor: boolean) => {
    setEnfocado(valor);
    alCambiarElFoco?.(valor);
  };

  const alCancelar = () => {
    onChangeText('');
    campo.current?.blur();
    Keyboard.dismiss();
  };

  return (
    <View style={[styles.fila, style]}>
      <Animated.View
        style={[
          styles.caja,
          { height: alto, backgroundColor: relleno },
          borde,
        ]}
      >
        {/*
          La lupa va DENTRO de la caja, como un hermano del campo, y ocupa
          siempre lo mismo: al convertirse en indicador no mueve el texto.
        */}
        <View style={styles.lupa}>
          {buscando ? (
            <ActivityIndicator size="small" color={colors.textMuted} />
          ) : (
            <Animated.View style={lupaAnimada}>
              <Feather name="search" size={16} color={enfocado ? colors.text : colors.textMuted} />
            </Animated.View>
          )}
        </View>
        <TextInput
          ref={campo}
          value={value}
          onChangeText={onChangeText}
          onFocus={() => cambiarFoco(true)}
          onBlur={() => cambiarFoco(false)}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          style={[styles.entrada, SIN_ANILLO_DEL_NAVEGADOR, { color: colors.text }]}
          accessibilityLabel={placeholder}
          // Un nombre no se escribe en mayúscula automática ni se autocorrige:
          // el corrector convertía apellidos poco comunes en otra palabra y la
          // búsqueda no encontraba a nadie.
          autoCapitalize="none"
          autoCorrect={false}
          // El teclado dice «buscar» en vez de «intro».
          returnKeyType="search"
          onSubmitEditing={onSubmitEditing ?? (() => Keyboard.dismiss())}
          autoFocus={autoFocus}
          // La X es propia y sale en las tres plataformas: iOS tiene la suya,
          // pero Android y web no.
          clearButtonMode="never"
        />
        {/*
          La X SOLO EXISTE cuando hay algo que borrar. Antes estaba siempre,
          invisible y apagada: no se veia, pero un lector de pantalla —y el
          navegador— la seguian anunciando como «Borrar la busqueda» sobre un
          campo vacio. Al aparecer crece desde su centro.
        */}
        {hayTexto ? (
          <Animated.View style={equisAnimada}>
            <Pulsable
              onPress={() => onChangeText('')}
              hitSlop={12}
              escala={ESCALA_AL_PULSAR.icono}
              accessibilityRole="button"
              accessibilityLabel={etiquetaDeLimpiar}
              style={[styles.equis, { backgroundColor: colors.textMuted }]}
            >
              <Feather name="x" size={12} color={colors.background} />
            </Pulsable>
          </Animated.View>
        ) : null}
      </Animated.View>

      {/*
        «Cancelar» abre su hueco al enfocar. Con el campo sin foco mide cero y
        no se puede pulsar ni lo lee el lector de pantalla.
      */}
      <Animated.View
        style={[styles.cancelar, cancelar]}
        pointerEvents={enfocado ? 'auto' : 'none'}
        // Tambien para el navegador: `aria-hidden` es lo que entiende la web.
        aria-hidden={!enfocado}
      >
        <Pulsable
          onPress={alCancelar}
          disabled={!enfocado}
          hitSlop={8}
          atenuar={0.6}
          accessibilityRole="button"
          accessibilityLabel={t('common.cancel')}
          accessibilityElementsHidden={!enfocado}
          importantForAccessibility={enfocado ? 'yes' : 'no-hide-descendants'}
          style={styles.botonDeCancelar}
        >
          <Text numberOfLines={1} weight="600" style={styles.textoDeCancelar}>
            {t('common.cancel')}
          </Text>
        </Pulsable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  fila: { flexDirection: 'row', alignItems: 'center' },
  caja: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    // Esquinas suaves, no cápsula: es la forma del buscador de una bandeja.
    borderRadius: radius.md,
    // El borde no cambia de grosor al enfocar, solo de tono: si cambiara, la
    // caja daría un salto de un punto al tocarla.
    borderWidth: 1,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm + 2,
  },
  lupa: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  // `flex: 1` para que el texto ocupe lo que sobra entre la lupa y la X. Sin
  // relleno propio: Android añade uno vertical que descuadra el texto.
  // Con la letra de la aplicación: sin ella lo escrito salía con la del
  // sistema. `minWidth: 0` para que en web el campo encoja y no empuje a la X.
  entrada: { ...getTextStyle('400'), flex: 1, minWidth: 0, fontSize: 15, padding: 0 },
  equis: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelar: { overflow: 'hidden' },
  botonDeCancelar: { minHeight: 36, justifyContent: 'center' },
  textoDeCancelar: { fontSize: 14 },
});
