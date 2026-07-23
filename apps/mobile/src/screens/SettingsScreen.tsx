import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppScreen } from '@/components/AppScreen';
import { AppHeader } from '@/components/AppHeader';
import { ListRow } from '@/components/ListRow';
import { LANGUAGE_NAMES } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { confirm, notify } from '@/lib/confirm';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function SettingsScreen() {
  const { colors, mode } = useAppTheme();
  const { t, language } = useTranslation();
  const router = useRouter();
  const toggleTheme = useAppStore((state) => state.toggleTheme);
  const resetDemo = useAppStore((state) => state.resetDemo);
  const user = useAppStore((state) => state.user);
  const signOut = useAuthStore((state) => state.signOut);
  const deleteAccount = useAuthStore((state) => state.deleteAccount);
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

  const handleDeleteAccount = async () => {
    // Doble confirmacion: es irreversible y se lleva todo el contenido. La
    // primera explica lo que pasa; la segunda es la ultima red antes de borrar.
    const ok = await confirm({
      title: 'Eliminar cuenta',
      message:
        'Se borrarán tu cuenta y todo tu contenido (publicaciones, comentarios, ' +
        'mensajes y audios) de forma permanente. Esta acción no se puede deshacer.',
      confirmLabel: 'Eliminar cuenta',
      destructive: true,
    });
    if (!ok) return;
    const reallySure = await confirm({
      title: '¿Seguro del todo?',
      message: 'No hay vuelta atrás. Tu cuenta se eliminará ahora mismo.',
      confirmLabel: 'Sí, eliminar',
      destructive: true,
    });
    if (!reallySure) return;
    try {
      await deleteAccount();
      router.replace('/');
    } catch {
      notify(
        'No se pudo eliminar la cuenta',
        'Inténtalo de nuevo en unos momentos. Tu cuenta sigue activa.',
      );
    }
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
      <AppHeader title={t('settings.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <ScrollView contentContainerStyle={styles.list}>
        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>{t('settings.display')}</Text>
        <ListRow
          title={t('settings.darkMode')}
          subtitle={t('settings.currently', { value: mode === 'dark' ? t('settings.dark') : t('settings.light') })}
          leftIcon="moon"
          rightIcon="refresh-cw"
          onPress={toggleTheme}
        />
        <ListRow
          title={t('settings.language')}
          subtitle={LANGUAGE_NAMES[language]}
          leftIcon="globe"
          rightIcon="chevron-right"
          onPress={() => router.push('/language')}
        />

        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>{t('settings.account')}</Text>
        {isLoggedIn && user && (
          <ListRow
            title={user.fullName || user.username}
            subtitle={user.email || user.username}
            leftIcon="user"
          />
        )}
        <ListRow
          title={t('settings.verification')}
          subtitle={t('settings.verificationBody')}
          leftIcon="check-circle"
          rightIcon="chevron-right"
          onPress={() => router.push('/verification')}
        />
        {isLoggedIn ? (
          <>
            <ListRow
              title={t('settings.signOut')}
              subtitle={t('settings.signOutBody')}
              leftIcon="log-out"
              destructive
              onPress={handleSignOut}
            />
            <ListRow
              title="Eliminar cuenta"
              subtitle="Borra tu cuenta y todo tu contenido de forma permanente"
              leftIcon="trash-2"
              destructive
              onPress={handleDeleteAccount}
            />
          </>
        ) : (
          <ListRow
            title={t('settings.signIn')}
            subtitle="Accede para publicar y comentar"
            leftIcon="log-in"
            rightIcon="chevron-right"
            onPress={() => router.push('/login')}
          />
        )}

        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>{t('settings.system')}</Text>
        <ListRow
          title={t('settings.reset')}
          subtitle={t('settings.resetBody')}
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
