import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import { ZLogo } from '@/components/ZLogo';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

/** Alto del header sin contar el inset superior. */
export const APP_HEADER_HEIGHT = 48;

type Props = {
  title?: string;
  back?: boolean;
  onBack?: () => void;
  rightIcon?: keyof typeof Feather.glyphMap;
  onRightPress?: () => void;
  /** Qué hace el botón derecho, para el lector de pantalla. Sin él, «Acción». */
  rightLabel?: string;
  /** Punto sobre el icono derecho: hay algo sin ver detras de el. */
  rightBadge?: boolean;
  /**
   * Contenido propio para la zona CENTRAL, en lugar del titulo de texto.
   *
   * OPCIONAL Y SIN EFECTO SI NO SE PASA: quien no lo use sigue viendo
   * exactamente lo de siempre —el logo cuando el titulo es «Z», el texto
   * centrado en el resto—, que es lo que hacen las demas pantallas. Existe
   * porque una conversacion necesita ensenar a la persona con la que se habla
   * (foto y nombre, pulsables) y eso no cabe en una cadena de texto.
   */
  center?: React.ReactNode;
};

export function AppHeader({
  title = 'Z',
  back = false,
  onBack,
  rightIcon,
  onRightPress,
  rightLabel,
  rightBadge = false,
  center,
}: Props) {
  const { t } = useTranslation();
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
            accessibilityLabel={t('common.back')}
            accessibilityRole="button"
            style={styles.backButton}
          >
            <Feather name="chevron-left" size={24} color={colors.text} />
          </Pressable>
        ) : null}
      </View>
      {/* La marca se pinta con su logo; el resto de pantallas llevan su
          nombre escrito. Asi Inicio muestra la Z con textura en vez de una
          letra suelta, sin tener que cambiar cada llamada al header. */}
      {center ? (
        <View style={styles.center}>{center}</View>
      ) : title === 'Z' ? (
        <View style={styles.brand}>
          <ZLogo size={30} />
        </View>
      ) : (
        <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>{title}</Text>
      )}
      <View style={[styles.side, { alignItems: 'flex-end' }]}>
        {rightIcon ? (
          <Pressable
            onPress={onRightPress}
            hitSlop={12}
            accessibilityLabel={rightLabel ?? t('common.rightAction')}
            accessibilityRole="button"
            style={styles.backButton}
          >
            <Feather name={rightIcon} size={22} color={colors.text} />
            {/* El punto no lleva texto: se acompana del propio icono, nunca es
                el color el unico portador de la informacion. */}
            {rightBadge ? (
              <View
                style={[styles.badge, { backgroundColor: colors.text, borderColor: colors.background }]}
              />
            ) : null}
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
  brand: { flex: 1, alignItems: 'center' },
  // `minWidth: 0` para que lo que se meta aqui se recorte en vez de empujar a
  // los botones de los lados fuera de la pantalla.
  center: { flex: 1, minWidth: 0, justifyContent: 'center' },
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
  badge: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 9,
    height: 9,
    borderRadius: 5,
    borderWidth: 1.5,
  },
});
