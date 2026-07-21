import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { postAuthRoute } from '@/lib/postAuthRoute';
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

const interestsOptions = [
  'Mentalidad',
  'Relaciones',
  'Negocios',
  'Salud',
  'Propósito',
  'Finanzas',
  'Hábitos',
  'Meditación',
];

export function OnboardingScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const complete = useAppStore((state) => state.setOnboardingComplete);

  const [index, setIndex] = useState(0);
  const [selectedInterests, setSelectedInterests] = useState<string[]>([]);

  // Si index === slides.length, mostramos el onboarding de intereses
  const showInterests = index === slides.length;

  const toggleInterest = (interest: string) => {
    setSelectedInterests((prev) =>
      prev.includes(interest)
        ? prev.filter((i) => i !== interest)
        : [...prev, interest]
    );
  };

  const next = () => {
    if (index < slides.length) {
      setIndex((value) => value + 1);
      return;
    }
    // Finalizar onboarding completo
    complete(true);
    router.replace(postAuthRoute() as never);
  };

  const skip = () => {
    complete(true);
    router.replace(postAuthRoute() as never);
  };

  if (showInterests) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="Tus Intereses" />
        <AppScreen contentStyle={styles.screen}>
          <View style={styles.content}>
            <Text style={[styles.title, { color: colors.text }]}>¿Qué te interesa aprender?</Text>
            <Text style={[styles.body, { color: colors.textMuted, marginBottom: spacing.xl }]}>
              Selecciona los temas de tu preferencia para personalizar tu feed.
            </Text>

            <View style={styles.chipsContainer}>
              {interestsOptions.map((interest) => {
                const isSelected = selectedInterests.includes(interest);
                return (
                  <Chip
                    key={interest}
                    label={interest}
                    selected={isSelected}
                    onPress={() => toggleInterest(interest)}
                  />
                );
              })}
            </View>
          </View>
          <View style={styles.footer}>
            <Button
              label="Comenzar"
              onPress={next}
              disabled={selectedInterests.length === 0}
            />
            <Button label="Saltar" variant="ghost" onPress={skip} />
          </View>
        </AppScreen>
      </View>
    );
  }

  const slide = slides[index]!;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="RENASER" onBack={index > 0 ? () => setIndex(index - 1) : undefined} />
      <AppScreen contentStyle={styles.screen}>
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
              <View
                key={dotIndex}
                style={[
                  styles.dot,
                  { backgroundColor: dotIndex === index ? colors.text : colors.border },
                ]}
              />
            ))}
          </View>
        </View>
        <View style={styles.footer}>
          <Button label="Continuar" onPress={next} />
          <Button label="Saltar" variant="ghost" onPress={skip} />
        </View>
      </AppScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { paddingHorizontal: spacing.xl, paddingBottom: spacing.lg, flex: 1 },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', marginTop: spacing.lg },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '900', textAlign: 'center' },
  body: { fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: spacing.md, maxWidth: 320 },
  logo: { width: 140, height: 140, borderRadius: 70, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginVertical: spacing.xl },
  logoInner: { width: 110, height: 110, borderRadius: 55, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  symbol: { fontSize: 52, fontWeight: '300' },
  dots: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  dot: { width: 7, height: 7, borderRadius: radius.pill },
  chipsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'center',
  },
  footer: {
    gap: spacing.xs,
    marginTop: spacing.xl,
  },
});
