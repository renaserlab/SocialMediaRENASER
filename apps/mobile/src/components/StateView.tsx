import React from 'react';
import { StyleSheet, View, ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import { Button } from './Button';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type StateType = 'loading' | 'empty' | 'error' | 'offline' | 'content';

type StateViewProps = {
  state: StateType;
  children?: React.ReactNode;
  title?: string;
  description?: string;
  onRetry?: () => void;
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
  loadingComponent,
  icon,
  style,
}: StateViewProps) {
  const { colors } = useAppTheme();

  if (state === 'content') {
    return <React.Fragment>{children}</React.Fragment>;
  }

  if (state === 'loading') {
    if (loadingComponent) {
      return <React.Fragment>{loadingComponent}</React.Fragment>;
    }
    return (
      <View style={[styles.centerContainer, style]}>
        <Text style={[styles.loadingText, { color: colors.textMuted }]}>Cargando...</Text>
      </View>
    );
  }

  // Resolver iconos por defecto
  let defaultIcon: keyof typeof Feather.glyphMap = 'info';
  let defaultTitle = '';
  let defaultDescription = '';

  if (state === 'empty') {
    defaultIcon = 'inbox';
    defaultTitle = 'No hay contenido disponible';
    defaultDescription = 'Vuelve a revisar más tarde.';
  } else if (state === 'error') {
    defaultIcon = 'alert-triangle';
    defaultTitle = 'Ha ocurrido un error';
    defaultDescription = 'No pudimos cargar la información. Inténtalo nuevamente.';
  } else if (state === 'offline') {
    defaultIcon = 'wifi-off';
    defaultTitle = 'Sin conexión a Internet';
    defaultDescription = 'Comprueba tu red y vuelve a intentarlo.';
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
      {state === 'error' && onRetry && (
        <Button
          label="Reintentar"
          onPress={onRetry}
          variant="secondary"
          style={styles.retryButton}
        />
      )}
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
