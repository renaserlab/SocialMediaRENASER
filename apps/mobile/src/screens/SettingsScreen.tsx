import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppScreen } from '@/components/AppScreen';
import { AppHeader } from '@/components/AppHeader';
import { ListRow } from '@/components/ListRow';
import { confirm } from '@/lib/confirm';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function SettingsScreen() {
  const { colors, mode } = useAppTheme();
  const router = useRouter();
  const toggleTheme = useAppStore((state) => state.toggleTheme);
  const resetDemo = useAppStore((state) => state.resetDemo);
  const user = useAppStore((state) => state.user);
  const signOut = useAuthStore((state) => state.signOut);
  const authStatus = useAuthStore((state) => state.status);

  const isLoggedIn = authStatus === 'authenticated';

  const handleSignOut = async () => {
    const ok = await confirm({
      title: 'Cerrar sesión',
      message: '¿Seguro que quieres salir de tu cuenta?',
      confirmLabel: 'Cerrar sesión',
      destructive: true,
    });
    if (!ok) return;
    await signOut();
    router.replace('/');
  };

  const handleReset = async () => {
    const ok = await confirm({
      title: 'Reiniciar aplicación',
      message:
        'Se restaurarán los datos de demo y se cerrará tu sesión. Esta acción no se puede deshacer.',
      confirmLabel: 'Reiniciar',
      destructive: true,
    });
    if (!ok) return;
    await signOut();
    resetDemo();
    router.replace('/');
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="Ajustes" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
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
        {isLoggedIn && user && (
          <ListRow
            title={user.fullName || user.username}
            subtitle={user.email || user.username}
            leftIcon="user"
          />
        )}
        <ListRow
          title="Verificación de Cuenta"
          subtitle="Ver estado de tu membresía"
          leftIcon="check-circle"
          rightIcon="chevron-right"
          onPress={() => router.push('/verification')}
        />
        {isLoggedIn ? (
          <ListRow
            title="Cerrar Sesión"
            subtitle="Salir de tu cuenta en este dispositivo"
            leftIcon="log-out"
            destructive
            onPress={handleSignOut}
          />
        ) : (
          <ListRow
            title="Iniciar Sesión"
            subtitle="Accede para publicar y comentar"
            leftIcon="log-in"
            rightIcon="chevron-right"
            onPress={() => router.push('/login')}
          />
        )}

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
