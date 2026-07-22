import React, { useEffect } from 'react';
import { Modal, Platform, Pressable, StyleSheet, View } from 'react-native';

import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type BottomSheetProps = {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
};

export function BottomSheet({ visible, onClose, children }: BottomSheetProps) {
  const { colors } = useAppTheme();

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
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.modalContainer}>
        {/* Overlay backdrop */}
        <Pressable
          style={[styles.backdrop, { backgroundColor: colors.overlay }]}
          onPress={onClose}
          accessibilityLabel="Cerrar panel"
          accessibilityRole="button"
        />

        {/* Content Sheet */}
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
            },
          ]}
        >
          {/* Handle bar */}
          <View style={[styles.handle, { backgroundColor: colors.border }]} />

          <View style={styles.content}>
            {children}
          </View>
        </View>
      </View>
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
    paddingBottom: spacing.xxl,
    paddingTop: spacing.sm,
    alignItems: 'stretch',
    maxHeight: '80%',
  },
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
