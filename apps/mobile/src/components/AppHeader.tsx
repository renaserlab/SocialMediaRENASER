import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/** Alto del header sin contar el inset superior. Lo consume useKeyboardOffset. */
export const APP_HEADER_HEIGHT = 48;

type Props = {
  title?: string;
  back?: boolean;
  onBack?: () => void;
  rightIcon?: keyof typeof Feather.glyphMap;
  onRightPress?: () => void;
};

export function AppHeader({ title = 'RENASER', back = false, onBack, rightIcon, onRightPress }: Props) {
  const { colors } = useAppTheme();
  const router = useRouter();
  // El header es el primer elemento de la pantalla: debe respetar el notch /
  // Dynamic Island. `AppScreen` ya no inyecta el inset superior (evita el hueco).
  const insets = useSafeAreaInsets();

  const handleBack = () => {
    if (onBack) {
      onBack();
      return;
    }
    // Sin historial (p. ej. tras un deep link) `back()` es un no-op y dejaria al
    // usuario atrapado: caemos al inicio.
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  return (
    <View style={[styles.row, { height: APP_HEADER_HEIGHT + insets.top, paddingTop: insets.top }]}>
      <View style={styles.side}>
        {back || onBack ? (
          <Pressable
            onPress={handleBack}
            hitSlop={12}
            accessibilityLabel="Volver"
            accessibilityRole="button"
            style={styles.backButton}
          >
            <Feather name="chevron-left" size={24} color={colors.text} />
          </Pressable>
        ) : null}
      </View>
      <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>{title}</Text>
      <View style={[styles.side, { alignItems: 'flex-end' }]}>
        {rightIcon ? (
          <Pressable
            onPress={onRightPress}
            hitSlop={12}
            accessibilityLabel="Acción derecha"
            accessibilityRole="button"
            style={styles.backButton}
          >
            <Feather name={rightIcon} size={22} color={colors.text} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    // La altura final se calcula en el componente: 48 + inset superior.
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
  },
  side: { width: 44 },
  title: {
    flex: 1,
    textAlign: 'center',
    fontWeight: '800',
    fontSize: 14,
    letterSpacing: 0.8,
  },
  backButton: {
    minWidth: 44,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
