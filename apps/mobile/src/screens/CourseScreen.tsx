import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { assets } from '@/data/assets';
import { useCourse } from '@/hooks/useCourse';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function CourseScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  // Curso a través de la capa de repositorio (mock hoy, backend mañana).
  const { course, loading, error, reload } = useCourse(id);
  const purchasedIds = useAppStore((state) => state.purchasedCourseIds);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="Programa" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <StateView state="loading" />
      </View>
    );
  }

  if (error || !course) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="Programa" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <StateView state="error" description={error ?? undefined} onRetry={reload} />
      </View>
    );
  }

  const purchased = purchasedIds.includes(course.id);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="Programa" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <AppScreen contentStyle={{ paddingBottom: spacing.xl }}>
        <Image source={assets.course} style={[styles.hero, { borderColor: colors.border }]} />
        <View style={styles.container}>
          <Text style={[styles.title, { color: colors.text }]}>{course.title}</Text>
          <Text style={[styles.price, { color: colors.text }]}>${course.price.toLocaleString()} {course.currency}</Text>
          <Text style={[styles.description, { color: colors.textMuted }]}>{course.description}</Text>

          <View style={[styles.info, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Info icon="book" label={`${course.modules} módulos`} />
            <Info icon="play-circle" label={`${course.lessons} lecciones`} />
            <Info icon="file-text" label="Plantillas y ejercicios" />
            <Info icon="users" label="Comunidad privada" />
          </View>

          <Text style={[styles.sectionTitle, { color: colors.text }]}>Lo que vas a desarrollar</Text>
          {['Claridad para tomar decisiones difíciles', 'Liderazgo personal y de equipos', 'Estrategia para convertir visión en resultados', 'Hábitos sostenibles sin agotamiento'].map((item) => (
            <View key={item} style={styles.bulletRow}>
              <Feather name="check" size={20} color={colors.success} style={{ marginTop: 2 }} />
              <Text style={[styles.bullet, { color: colors.text }]}>{item}</Text>
            </View>
          ))}

          <Button
            label={purchased ? 'Ir al curso' : 'Comprar ahora'}
            onPress={() => purchased ? router.push('/lesson/1' as any) : router.push(`/checkout/${course.id}` as any)}
            style={{ marginTop: spacing.xl }}
          />
        </View>
      </AppScreen>
    </View>
  );
}

function Info({ icon, label }: { icon: keyof typeof Feather.glyphMap; label: string }) {
  const { colors } = useAppTheme();
  return (
    <View style={styles.infoRow}>
      <Feather name={icon} size={20} color={colors.text} />
      <Text style={{ color: colors.textMuted, fontSize: 13 }}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { width: '100%', aspectRatio: 1.1, resizeMode: 'cover', borderWidth: 1 },
  container: { padding: spacing.xl },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '900' },
  price: { fontSize: 20, fontWeight: '900', marginTop: spacing.md },
  description: { fontSize: 14, lineHeight: 21, marginTop: spacing.md },
  info: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.lg, gap: spacing.md, marginVertical: spacing.xl },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  sectionTitle: { fontSize: 18, fontWeight: '900', marginBottom: spacing.lg },
  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, marginBottom: spacing.md },
  bullet: { flex: 1, fontSize: 14, lineHeight: 20 },
});
