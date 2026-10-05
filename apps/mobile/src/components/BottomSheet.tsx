import React, { useEffect } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Aparecer } from '@/components/Aparecer';
import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type BottomSheetProps = {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /**
   * Si la hoja pone su propio `ScrollView`. Por defecto si.
   *
   * Se apaga cuando dentro va una lista VIRTUALIZADA (`FlashList`,
   * `FlatList`). Anidar una lista virtualizada en un `ScrollView` le quita la
   * altura con la que decide que filas existen: se renderizan todas, se pierde
   * el reciclado y React Native avisa por consola. Con `desplazable={false}` el
   * hijo recibe el alto de la hoja y lleva el desplazamiento el mismo.
   *
   * Los formularios —que son casi todas las hojas— no tocan nada.
   */
  desplazable?: boolean;
};

export function BottomSheet({
  visible,
  onClose,
  children,
  desplazable = true,
}: BottomSheetProps) {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();

  /**
   * En web el Modal marca el resto de la pagina como `aria-hidden`. Si el boton
   * que abrio la hoja conserva el foco, queda dentro de esa zona oculta y el
   * navegador avisa de que se esta escondiendo un elemento enfocado de los
   * lectores de pantalla. Se le quita el foco al abrir.
   */
  useEffect(() => {
    if (!visible || Platform.OS !== 'web') return;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (active instanceof HTMLElement) active.blur();
  }, [visible]);

  return (
    <Modal
      transparent
      visible={visible}
      /*
        EL FONDO SE FUNDE Y LA HOJA SUBE. Con `slide` subía todo el modal a la
        vez —el velo oscuro incluido—, como una persiana: el fondo se oscurecía
        de abajo arriba y se notaba el corte. Ahora el velo aparece en toda la
        pantalla y la hoja entra sola desde abajo (`Aparecer`), que es como se
        comportan las hojas del sistema. Al cerrar, todo se funde.
      */
      animationType="fade"
      onRequestClose={onClose}
    >
      {/*
        La hoja esta PEGADA al borde inferior, que es exactamente donde aparece
        el teclado: sin esto, cualquier campo de dentro —escribir una resena, un
        testimonio, el titulo de una leccion— quedaba tapado en cuanto se tocaba.
        Se resuelve aqui, en la hoja compartida, y no en cada formulario.
      */}
      <SinTecladoDelante style={styles.modalContainer}>
        {/* Overlay backdrop */}
        <Pressable
          style={[styles.backdrop, { backgroundColor: colors.overlay }]}
          onPress={onClose}
          accessibilityLabel="Cerrar panel"
          accessibilityRole="button"
        />

        {/* Content Sheet */}
        <Aparecer
          desde={56}
          style={[
            styles.sheet,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
              /*
                La zona segura del aparato, no un numero fijo. Con
                `spacing.xxl` a secas el ultimo boton de la hoja quedaba sobre
                el indicador de inicio del iPhone.
              */
              paddingBottom: Math.max(insets.bottom, spacing.md) + spacing.md,
            },
          ]}
        >
          {/* Handle bar */}
          <View style={[styles.handle, { backgroundColor: colors.border }]} />

          {/*
            LA HOJA SE DESPLAZA. Antes era un `View` dentro de un contenedor con
            `maxHeight: '80%'`: cuando el contenido no cabia —el formulario de
            una leccion son siete controles, uno de ellos multilinea— se
            RECORTABA por abajo, y lo que se perdia era justo lo ultimo, que es
            siempre el boton de guardar. No estaba tapado: es que no habia forma
            de llegar a el.

            `flexShrink` y no `flex`: sin contenido de sobra la hoja sigue
            midiendo lo que mide su contenido —que es lo que la hace sentir
            ligera— y solo cuando se pasa del tope empieza a encogerse y a
            desplazarse.
          */}
          {desplazable ? (
            <ScrollView
              style={styles.contentScroll}
              contentContainerStyle={styles.content}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {children}
            </ScrollView>
          ) : (
            <View style={[styles.contentScroll, styles.content]}>{children}</View>
          )}
        </Aparecer>
      </SinTecladoDelante>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalContainer: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  sheet: {
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: 1,
    // `paddingBottom` lo pone el componente: sale de la zona segura.
    paddingTop: spacing.sm,
    alignItems: 'stretch',
    maxHeight: '80%',
  },
  contentScroll: { flexShrink: 1 },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: spacing.md,
  },
  content: {
    paddingHorizontal: spacing.lg,
  },
});
