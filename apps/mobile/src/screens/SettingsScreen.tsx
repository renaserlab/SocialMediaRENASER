import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppScreen } from '@/components/AppScreen';
import { AppHeader } from '@/components/AppHeader';
import { ListRow } from '@/components/ListRow';
import { useAppStore } from '@/store/useAppStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function SettingsScreen() {
  const { colors, mode } = useAppTheme();
  const router = useRouter();
  const toggleTheme = useAppStore((state) => state.toggleTheme);
  const resetDemo = useAppStore((state) => state.resetDemo);

  const handleReset = () => {
    resetDemo();
    router.replace('/');
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="Ajustes" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.list}>
        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>Visualización</Text>
        <ListRow
          title="Modo Oscuro"
          subtitle={`Actualmente: ${mode === 'dark' ? 'Oscuro' : 'Claro'}`}
          leftIcon="moon"
          rightIcon="refresh-cw"
          onPress={toggleTheme}
        />
        <ListRow
          title="Idioma de la App"
          subtitle="Español (ES)"
          leftIcon="globe"
          rightIcon="chevron-right"
          onPress={() => router.push('/language')}
        />

        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>Cuenta & Membresía</Text>
        <ListRow
          title="Verificación de Cuenta"
          subtitle="Ver estado de tu membresía"
          leftIcon="check-circle"
          rightIcon="chevron-right"
          onPress={() => router.push('/verification')}
        />

        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>Sistema</Text>
        <ListRow
          title="Reiniciar Aplicación"
          subtitle="Restaurar base de datos y reiniciar demo"
          leftIcon="trash-2"
          onPress={handleReset}
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    paddingBottom: spacing.lg,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
    letterSpacing: 0.5,
  },
});
