import React, { useCallback, useEffect, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/Text';
import { registerDialogHost, type DialogRequest } from '@/lib/confirm';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Dialogo de confirmacion y avisos de la app.
 *
 * Se monta UNA vez en el layout raiz. `confirm()` y `notify()` le envian la
 * peticion a traves de `registerDialogHost`, de modo que las 15 llamadas que ya
 * existen no cambian: solo cambia como se ve.
 *
 * Las peticiones se encolan. Sin cola, dos avisos seguidos (p. ej. dos subidas
 * que fallan a la vez) harian que el segundo pisara al primero.
 */
export function DialogHost() {
  const { colors } = useAppTheme();
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  const current = queue[0] ?? null;

  const present = useCallback((request: DialogRequest) => {
    // En web, el boton que abrio el dialogo conserva el foco dentro de la zona
    // que el Modal marca como aria-hidden, y el navegador avisa por
    // accesibilidad. Se le quita el foco al abrir.
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
    setQueue((prev) => [...prev, request]);
  }, []);

  useEffect(() => {
    registerDialogHost(present);
    return () => registerDialogHost(null);
  }, [present]);

  const close = (accepted: boolean) => {
    if (!current) return;
    current.resolve(accepted);
    setQueue((prev) => prev.slice(1));
  };

  if (!current) return null;

  const onlyConfirm = current.cancelLabel === undefined;

  return (
    <Modal transparent visible animationType="fade" onRequestClose={() => close(false)}>
      <View style={styles.root}>
        {/*
          Tocar fuera equivale a cancelar. En un aviso de un solo boton tambien
          lo cierra: no hay nada que decidir.
        */}
        <Pressable
          style={[styles.backdrop, { backgroundColor: colors.overlay }]}
          onPress={() => close(false)}
          accessibilityLabel="Cerrar"
          accessibilityRole="button"
        />

        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text variant="body" weight="800" style={styles.title}>
            {current.title}
          </Text>
          {current.message ? (
            <Text variant="secondary" color={colors.textMuted} style={styles.message}>
              {current.message}
            </Text>
          ) : null}

          <View style={styles.actions}>
            {!onlyConfirm ? (
              <Pressable
                onPress={() => close(false)}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.button,
                  { borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
                ]}
              >
                <Text variant="body" weight="700">
                  {current.cancelLabel}
                </Text>
              </Pressable>
            ) : null}

            <Pressable
              onPress={() => close(true)}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.button,
                styles.buttonPrimary,
                {
                  backgroundColor: current.destructive ? colors.danger : colors.primary,
                  borderColor: current.destructive ? colors.danger : colors.primary,
                  opacity: pressed ? 0.8 : 1,
                },
              ]}
            >
              <Text variant="body" weight="700" color={colors.onPrimary}>
                {current.confirmLabel}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  backdrop: { ...StyleSheet.absoluteFillObject },
  card: {
    width: '100%',
    maxWidth: 360,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.xl,
  },
  title: { marginBottom: spacing.xs },
  message: { lineHeight: 19, marginBottom: spacing.lg },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  button: {
    minHeight: 44,
    minWidth: 96,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPrimary: { borderWidth: 1 },
});
