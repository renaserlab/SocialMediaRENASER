import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Image, StyleSheet, Text, View } from 'react-native';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { PrimaryButton } from '@/components/PrimaryButton';
import { assets } from '@/data/assets';
import { course } from '@/data/mockData';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function CourseScreen() {
  const { colors } = useAppTheme();
  const purchased = useAppStore((state) => state.purchasedCourseIds.includes(course.id));

  return (
    <AppScreen contentStyle={{ paddingBottom: spacing.xl }}>
      <AppHeader back title="Programa" />
      <Image source={assets.course} style={styles.hero} />
      <View style={styles.container}>
        <Text style={[styles.title, { color: colors.text }]}>{course.title}</Text>
        <Text style={[styles.price, { color: colors.text }]}>${course.price.toLocaleString()} {course.currency}</Text>
        <Text style={[styles.description, { color: colors.textMuted }]}>{course.description}</Text>

        <View style={[styles.info, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Info icon="library-outline" label={`${course.modules} módulos`} />
          <Info icon="play-circle-outline" label={`${course.lessons} lecciones`} />
          <Info icon="document-text-outline" label="Plantillas y ejercicios" />
          <Info icon="people-outline" label="Comunidad privada" />
        </View>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>Lo que vas a desarrollar</Text>
        {['Claridad para tomar decisiones difíciles', 'Liderazgo personal y de equipos', 'Estrategia para convertir visión en resultados', 'Hábitos sostenibles sin agotamiento'].map((item) => (
          <View key={item} style={styles.bulletRow}>
            <Ionicons name="checkmark-circle" size={22} color={colors.success} />
            <Text style={[styles.bullet, { color: colors.text }]}>{item}</Text>
          </View>
        ))}

        <PrimaryButton
          label={purchased ? 'Ir al curso' : 'Comprar ahora'}
          onPress={() => purchased ? router.push('/confirmation') : router.push(`/checkout/${course.id}`)}
          style={{ marginTop: spacing.xl }}
        />
      </View>
    </AppScreen>
  );
}

function Info({ icon, label }: { icon: keyof typeof Ionicons.glyphMap; label: string }) {
  const { colors } = useAppTheme();
  return <View style={styles.infoRow}><Ionicons name={icon} size={20} color={colors.text} /><Text style={{ color: colors.textMuted, fontSize: 13 }}>{label}</Text></View>;
}

const styles = StyleSheet.create({
  hero: { width: '100%', aspectRatio: 0.95 },
  container: { padding: spacing.xl },
  title: { fontSize: 30, lineHeight: 36, fontWeight: '900' },
  price: { fontSize: 22, fontWeight: '900', marginTop: spacing.md },
  description: { fontSize: 14, lineHeight: 21, marginTop: spacing.md },
  info: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.lg, gap: spacing.md, marginVertical: spacing.xl },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  sectionTitle: { fontSize: 20, fontWeight: '900', marginBottom: spacing.lg },
  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, marginBottom: spacing.md },
  bullet: { flex: 1, fontSize: 14, lineHeight: 20 },
});
