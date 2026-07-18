import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { PrimaryButton } from '@/components/PrimaryButton';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

const slides = [
  {
    title: 'Bienvenido a RENASER Universo',
    body: 'El lugar donde el crecimiento personal se convierte en transformación real.',
    symbol: 'R',
  },
  {
    title: 'Conecta con personas que también avanzan',
    body: 'Comparte aprendizajes, participa en círculos y recibe acompañamiento de mentores.',
    symbol: '∞',
  },
  {
    title: 'Construye tu siguiente nivel',
    body: 'Audios, cursos, eventos y experiencias diseñadas para convertir claridad en acción.',
    symbol: '↑',
  },
];

export function OnboardingScreen() {
  const { colors } = useAppTheme();
  const complete = useAppStore((state) => state.setOnboardingComplete);
  const [index, setIndex] = useState(0);
  const slide = slides[index] ?? slides[0]!;
  const isLast = index === slides.length - 1;

  const next = () => {
    if (!isLast) {
      setIndex((value) => value + 1);
      return;
    }
    complete(true);
    router.replace('/(tabs)/home');
  };

  const skip = () => {
    complete(true);
    router.replace('/(tabs)/home');
  };

  return (
    <AppScreen contentStyle={styles.screen}>
      <AppHeader back={index > 0} title="RENASER" />
      <View style={styles.content}>
        <Text style={[styles.title, { color: colors.text }]}>{slide.title}</Text>
        <Text style={[styles.body, { color: colors.textMuted }]}>{slide.body}</Text>
        <View style={[styles.logo, { borderColor: colors.text }]}>
          <View style={[styles.logoInner, { borderColor: colors.border }]}>
            <Text style={[styles.symbol, { color: colors.text }]}>{slide.symbol}</Text>
          </View>
        </View>
        <View style={styles.dots}>
          {slides.map((_, dotIndex) => (
            <View key={dotIndex} style={[styles.dot, { backgroundColor: dotIndex === index ? colors.text : colors.border }]} />
          ))}
        </View>
      </View>
      <PrimaryButton label={isLast ? 'Comenzar' : 'Continuar'} onPress={next} />
      <PrimaryButton label="Saltar" variant="ghost" onPress={skip} />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  screen: { paddingHorizontal: spacing.xl, paddingBottom: spacing.lg },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 28, lineHeight: 34, fontWeight: '900', textAlign: 'center' },
  body: { fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: spacing.lg, maxWidth: 320 },
  logo: { width: 190, height: 190, borderRadius: 95, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginVertical: spacing.xxxl },
  logoInner: { width: 145, height: 145, borderRadius: 73, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  symbol: { fontSize: 72, fontWeight: '300' },
  dots: { flexDirection: 'row', gap: spacing.sm },
  dot: { width: 7, height: 7, borderRadius: radius.pill },
});
