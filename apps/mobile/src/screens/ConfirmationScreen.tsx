import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { useCourse } from '@/hooks/useCourse';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

export function ConfirmationScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  // El curso recien comprado. Antes se mostraba SIEMPRE el curso de demo,
  // asi que la confirmacion anunciaba un producto distinto al comprado.
  const { courseId } = useLocalSearchParams<{ courseId?: string }>();
  const { course, lessons } = useCourse(courseId);
  const firstLessonId = (lessons.find((l) => !l.completed) ?? lessons[0])?.id;

  return (
    <AppScreen contentStyle={styles.screen} edges={['top', 'left', 'right', 'bottom']}>
      <View style={styles.content}>
        <View style={[styles.check, { borderColor: colors.text }]}>
          <Feather name="check" size={54} color={colors.text} />
        </View>
        <Text style={[styles.title, { color: colors.text }]}>{t('confirm.paid')}</Text>
        <Text style={[styles.body, { color: colors.textMuted }]}>
          {t('confirm.access')}
          {`\n`}
          {course?.title ?? t('confirm.yourNewCourse')}
        </Text>
      </View>
      <Button
        label={t('confirm.goToCourse')}
        // Antes iba a '/lesson/1', un id del prototipo: con datos reales el
        // usuario acababa en un error justo despues de pagar.
        onPress={() =>
          router.replace(
            (firstLessonId
              ? `/lesson/${firstLessonId}`
              : courseId
              ? `/course/${courseId}`
              : '/(tabs)/home') as never,
          )
        }
      />
      <Button
        label={t('confirm.backHome')}
        variant="secondary"
        onPress={() => router.replace('/(tabs)/home')}
      />
      <Text style={[styles.email, { color: colors.textMuted }]}>{t('confirm.emailSent')}</Text>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  screen: { padding: spacing.xl, gap: spacing.md, minHeight: '100%' },
  content: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  check: { width: 110, height: 110, borderRadius: 55, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: '900', marginTop: spacing.xl },
  body: { fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: spacing.md },
  email: { fontSize: 11, textAlign: 'center', marginTop: spacing.md },
});
