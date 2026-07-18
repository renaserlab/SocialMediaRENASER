import { router } from 'expo-router';
import { Image, StyleSheet, Text, View } from 'react-native';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { PrimaryButton } from '@/components/PrimaryButton';
import { assets } from '@/data/assets';
import { useAppStore } from '@/store/useAppStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { QuizArea } from '@/types';

const resultCopy: Record<QuizArea, { headline: string; description: string }> = {
  mentalidad: { headline: 'Tu principal límite no es la estrategia. Eres tú.', description: 'Tus pensamientos y patrones automáticos están saboteando tu siguiente nivel.' },
  relaciones: { headline: 'Tu crecimiento necesita relaciones más conscientes.', description: 'Los límites, la comunicación y la forma de vincularte están marcando tu avance.' },
  negocios: { headline: 'Tu esfuerzo necesita una estrategia que pueda escalar.', description: 'No necesitas trabajar más: necesitas foco, estructura y decisiones financieras más claras.' },
  salud: { headline: 'Tu energía es la base de todo lo que quieres construir.', description: 'El siguiente nivel empieza por recuperar el equilibrio físico y emocional.' },
  proposito: { headline: 'No estás perdido. Estás listo para una dirección más auténtica.', description: 'Tus metas necesitan alinearse con la vida que realmente deseas construir.' },
};

export function ResultScreen() {
  const { colors } = useAppTheme();
  const result = useAppStore((state) => state.quizResult) ?? 'mentalidad';
  const copy = resultCopy[result];
  const user = useAppStore((state) => state.user);

  return (
    <AppScreen contentStyle={{ paddingBottom: spacing.xl }}>
      <AppHeader back title="Tu resultado" />
      <View style={styles.content}>
        <Text style={[styles.title, { color: colors.text }]}>{copy.headline}</Text>
        <Text style={[styles.description, { color: colors.textMuted }]}>{copy.description}</Text>
        <Image source={assets.event} style={styles.resultImage} />
        <Text style={[styles.note, { color: colors.textMuted }]}>Preparamos un audio privado con recomendaciones específicas para ti.</Text>
        <PrimaryButton
          label="Escuchar ahora"
          icon="🎧"
          onPress={() => user ? router.push('/audio/private') : router.push('/register')}
        />
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: spacing.xl, alignItems: 'center' },
  title: { fontSize: 31, lineHeight: 36, textAlign: 'center', fontWeight: '900', marginTop: spacing.xl },
  description: { fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: spacing.lg },
  resultImage: { width: 230, height: 230, borderRadius: 115, marginVertical: spacing.xxl },
  note: { fontSize: 13, lineHeight: 19, textAlign: 'center', marginBottom: spacing.xl },
});
