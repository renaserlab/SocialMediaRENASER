import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { assets } from '@/data/assets';
import { useAppStore } from '@/store/useAppStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { QuizArea } from '@/types';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';

// Claves, no textos: el resultado se lee en el idioma elegido.
const resultCopy: Record<QuizArea, { headline: TranslationKey; description: TranslationKey }> = {
  mentalidad: { headline: 'result.mindsetTitle', description: 'result.mindsetBody' },
  relaciones: { headline: 'result.relationsTitle', description: 'result.relationsBody' },
  negocios: { headline: 'result.businessTitle', description: 'result.businessBody' },
  salud: { headline: 'result.healthTitle', description: 'result.healthBody' },
  proposito: { headline: 'result.purposeTitle', description: 'result.purposeBody' },
};

// Imagen acorde a cada área de resultado.
const resultImage: Record<QuizArea, keyof typeof assets> = {
  mentalidad: 'hero',
  relaciones: 'avatar',
  negocios: 'course',
  salud: 'speaker',
  proposito: 'circle',
};

export function ResultScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const result = useAppStore((state) => state.quizResult) ?? 'mentalidad';
  const copy = resultCopy[result];
  const user = useAppStore((state) => state.user);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title={t('result.title')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />
      <AppScreen contentStyle={{ paddingBottom: spacing.xl }}>
        <View style={styles.content}>
          <Text style={[styles.title, { color: colors.text }]}>{t(copy.headline)}</Text>
          <Text style={[styles.description, { color: colors.textMuted }]}>
            {t(copy.description)}
          </Text>
          <Image
            source={assets[resultImage[result]]}
            style={[styles.resultImage, { borderColor: colors.border }]}
          />
          <Text style={[styles.note, { color: colors.textMuted }]}>
            {t('result.audioNote')}
          </Text>
          <Button
            label={t('result.listenNow')}
            icon="headphones"
            onPress={() => user ? router.push('/audio/private') : router.push('/register')}
            style={styles.btn}
          />
        </View>
      </AppScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: spacing.xl, alignItems: 'center' },
  title: { fontSize: 24, lineHeight: 30, textAlign: 'center', fontWeight: '900', marginTop: spacing.lg },
  description: { fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: spacing.md },
  resultImage: { width: 180, height: 180, borderRadius: 90, borderWidth: 1, marginVertical: spacing.xl },
  note: { fontSize: 13, lineHeight: 18, textAlign: 'center', marginBottom: spacing.lg },
  btn: { width: '100%' },
});
