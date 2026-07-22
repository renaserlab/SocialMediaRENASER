import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppScreen } from '@/components/AppScreen';
import { AppHeader } from '@/components/AppHeader';
import { Button } from '@/components/Button';
import { useAppStore } from '@/store/useAppStore';
import { spacing, radius } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function VerificationScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const user = useAppStore((state) => state.user);

  const [status, setStatus] = useState<'none' | 'pending' | 'verified'>('none');

  const requestVerification = () => {
    setStatus('pending');
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="Verificación de Cuenta" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <AppScreen scroll={false}>
        <View style={styles.container}>
          <View style={styles.iconContainer}>
            <View style={[styles.badge, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
              <Feather
                name={status === 'verified' ? 'check-circle' : status === 'pending' ? 'clock' : 'shield'}
                size={64}
                color={status === 'verified' ? colors.success : colors.textMuted}
              />
            </View>
          </View>

          <View style={styles.info}>
            <Text style={[styles.title, { color: colors.text }]}>
              {status === 'verified'
                ? '¡Tu cuenta está verificada!'
                : status === 'pending'
                ? 'Verificación en proceso'
                : 'Obtén tu cuenta verificada'}
            </Text>
            <Text style={[styles.description, { color: colors.textMuted }]}>
              {status === 'verified'
                ? 'Tienes acceso completo a todas las funciones premium, mentorías exclusivas y el Círculo de Liderazgo.'
                : status === 'pending'
                ? 'Estamos revisando tu solicitud. Este proceso suele tardar menos de 24 horas laborables.'
                : 'La insignia de verificación demuestra a la comunidad que tu membresía está activa y validada.'}
            </Text>
          </View>

          <View style={styles.footer}>
            {status === 'none' && (
              <Button label="Solicitar Verificación" onPress={requestVerification} />
            )}
            {status === 'pending' && (
              <Button
                label="Simular Aprobación (Demo)"
                variant="secondary"
                onPress={() => setStatus('verified')}
              />
            )}
            {status === 'verified' && (
              <Button label="Volver a Ajustes" variant="ghost" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
            )}
          </View>
        </View>
      </AppScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: spacing.xl,
    justifyContent: 'space-between',
  },
  iconContainer: {
    alignItems: 'center',
    marginTop: spacing.xl,
  },
  badge: {
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: {
    alignItems: 'center',
    gap: spacing.sm,
  },
  title: {
    fontSize: 20,
    fontWeight: '800',
    textAlign: 'center',
  },
  description: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  footer: {
    marginBottom: spacing.xl,
  },
});
