import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { Pulsable } from '@/components/Pulsable';
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
  /**
   * El título EN GRANDE y a la izquierda, como el de una bandeja.
   *
   * Para las pantallas que son el destino de una pestaña y no tienen a dónde
   * volver (Mensajes): ahí un rótulo pequeño, centrado y en mayúsculas se lee
   * como la cabecera de un formulario. Mismo alto que la cabecera normal, así
   * que nada de lo que hay debajo cambia de sitio.
   */
  grande?: boolean;
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
  grande = false,
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

  const derecha = rightIcon ? (
    <Pulsable
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
    </Pulsable>
  ) : null;

  if (grande) {
    return (
      <View
        style={[
          styles.row,
          styles.filaGrande,
          { height: APP_HEADER_HEIGHT + insets.top, paddingTop: insets.top },
        ]}
      >
        <Text
          numberOfLines={1}
          variant="title"
          weight="900"
          accessibilityRole="header"
          style={styles.tituloGrande}
        >
          {title}
        </Text>
        {derecha}
      </View>
    );
  }

  return (
    <View style={[styles.row, { height: APP_HEADER_HEIGHT + insets.top, paddingTop: insets.top }]}>
      <View style={styles.side}>
        {back || onBack ? (
          <Pulsable
            onPress={handleBack}
            hitSlop={12}
            accessibilityLabel={t('common.back')}
            accessibilityRole="button"
            style={styles.backButton}
          >
            <Feather name="chevron-left" size={24} color={colors.text} />
          </Pulsable>
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
      <View style={[styles.side, { alignItems: 'flex-end' }]}>{derecha}</View>
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
  filaGrande: { justifyContent: 'space-between', gap: spacing.md },
  // `flexShrink` para que un título largo se recorte antes de empujar al botón.
  tituloGrande: { flexShrink: 1 },
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
