import React from 'react';
import { StyleSheet, View, ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import { Button } from './Button';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type StateType = 'loading' | 'empty' | 'error' | 'offline' | 'content';

type StateViewProps = {
  state: StateType;
  children?: React.ReactNode;
  title?: string;
  description?: string;
  /**
   * Reintentar. Se pinta en 'error' Y en 'offline'.
   *
   * SIN CONEXION TAMBIEN SE REINTENTA. Solo se pintaba en 'error', asi que
   * siete pantallas ensenaban «sin conexion» sin nada que pulsar: la red
   * volvia un segundo despues y la unica salida era salir con Atras y volver a
   * entrar. En una puerta, con gente detras, eso es una pantalla muerta.
   */
  onRetry?: () => void;
  /**
   * Accion principal, disponible en cualquier estado salvo carga.
   *
   * `onRetry` solo pintaba boton en 'error', asi que un estado vacio quedaba
   * sin salida (p. ej. el perfil de un usuario sin sesion: pedia iniciar
   * sesion pero no ofrecia como).
   */
  actionLabel?: string;
  onAction?: () => void;
  loadingComponent?: React.ReactNode;
  icon?: keyof typeof Feather.glyphMap;
  style?: ViewStyle;
};

export function StateView({
  state,
  children,
  title,
  description,
  onRetry,
  actionLabel,
  onAction,
  loadingComponent,
  icon,
  style,
}: StateViewProps) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();

  if (state === 'content') {
    return <React.Fragment>{children}</React.Fragment>;
  }

  if (state === 'loading') {
    if (loadingComponent) {
      return <React.Fragment>{loadingComponent}</React.Fragment>;
    }
    return (
      <View style={[styles.centerContainer, style]}>
        <Text style={[styles.loadingText, { color: colors.textMuted }]}>
          {t('common.loading')}
        </Text>
      </View>
    );
  }

  // Resolver iconos por defecto
  let defaultIcon: keyof typeof Feather.glyphMap = 'info';
  let defaultTitle = '';
  let defaultDescription = '';

  if (state === 'empty') {
    defaultIcon = 'inbox';
    defaultTitle = t('state.emptyTitle');
    defaultDescription = t('state.emptyBody');
  } else if (state === 'error') {
    defaultIcon = 'alert-triangle';
    defaultTitle = t('state.errorTitle');
    defaultDescription = t('state.errorBody');
  } else if (state === 'offline') {
    defaultIcon = 'wifi-off';
    defaultTitle = t('state.offlineTitle');
    defaultDescription = t('state.offlineBody');
  }

  const finalIcon = icon || defaultIcon;
  const finalTitle = title || defaultTitle;
  const finalDescription = description || defaultDescription;

  return (
    <View style={[styles.centerContainer, style]}>
      <Feather name={finalIcon} size={48} color={colors.textMuted} style={styles.icon} />
      <Text style={[styles.title, { color: colors.text }]}>{finalTitle}</Text>
      {finalDescription && (
        <Text style={[styles.description, { color: colors.textMuted }]}>
          {finalDescription}
        </Text>
      )}
      {onAction && actionLabel ? (
        <Button
          label={actionLabel}
          onPress={onAction}
          variant="secondary"
          style={styles.retryButton}
        />
      ) : (state === 'error' || state === 'offline') && onRetry ? (
        <Button
          label={t('common.retry')}
          onPress={onRetry}
          variant="secondary"
          style={styles.retryButton}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  centerContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxl,
    minHeight: 250,
  },
  icon: {
    marginBottom: spacing.md,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  description: {
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: spacing.lg,
  },
  retryButton: {
    minWidth: 120,
  },
  loadingText: {
    fontSize: 14,
    fontWeight: '600',
  },
});
