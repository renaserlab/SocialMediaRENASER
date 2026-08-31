import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppScreen } from '@/components/AppScreen';
import { AppHeader } from '@/components/AppHeader';
import { Button } from '@/components/Button';
import { useTranslation } from '@/i18n/useTranslation';
import { useAppStore } from '@/store/useAppStore';
import { spacing, radius } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function VerificationScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const user = useAppStore((state) => state.user);

  const [status, setStatus] = useState<'none' | 'pending' | 'verified'>('none');

  const requestVerification = () => {
    setStatus('pending');
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title={t('settings.verification')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />
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
                ? t('verify.titleVerified')
                : status === 'pending'
                ? t('verify.titlePending')
                : t('verify.titleNone')}
            </Text>
            <Text style={[styles.description, { color: colors.textMuted }]}>
              {status === 'verified'
                ? t('verify.bodyVerified')
                : status === 'pending'
                ? t('verify.bodyPending')
                : t('verify.bodyNone')}
            </Text>
          </View>

          <View style={styles.footer}>
            {status === 'none' && (
              <Button label={t('verify.request')} onPress={requestVerification} />
            )}
            {/*
              «Simular Aprobación (Demo)» se verifica a si mismo con un toque:
              es el mismo resto de demostracion que «Reiniciar aplicacion», y a
              un usuario real solo le puede dar una insignia que nadie ha
              revisado. Se esconde igual, con `__DEV__`. En produccion, quien
              esta en revision no ve boton, que es lo correcto: no hay nada que
              pueda hacer hasta que le respondan.
            */}
            {status === 'pending' && __DEV__ && (
              <Button
                label={t('verify.simulate')}
                variant="secondary"
                onPress={() => setStatus('verified')}
              />
            )}
            {status === 'verified' && (
              <Button
                label={t('verify.back')}
                variant="ghost"
                onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
              />
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
