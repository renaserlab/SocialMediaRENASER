import React from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { assets } from '@/data/assets';
import { palette, spacing } from '@/theme/tokens';

// La landing es una portada intencionalmente oscura en ambos temas.
const media = palette('dark');

export function LandingScreen() {
  const router = useRouter();

  return (
    <View style={{ flex: 1, backgroundColor: media.background }}>
      <AppScreen scroll edges={['left', 'right', 'bottom']}>
        <View style={styles.mediaContainer}>
          <Image source={assets.hero} style={styles.image} resizeMode="cover" />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: media.overlay }]} />
          <View style={styles.brandContainer}>
            <Text variant="body" weight="800" color={media.text} style={styles.brandText}>
              RENASER
            </Text>
          </View>
        </View>

        <View style={styles.infoContainer}>
          <Text variant="display" color={media.text} style={styles.title}>
            ¿Qué está bloqueando realmente tu crecimiento?
          </Text>
          <Text variant="body" color={media.textMuted} style={styles.subtitle}>
            Responde 7 preguntas y descubre tu verdadero límite.
          </Text>
          <Button
            label="Descubrir ahora"
            variant="secondary"
            onPress={() => router.push('/quiz' as any)}
          />
          <Text variant="secondary" color={media.textMuted} style={styles.hint}>
            2 min · Gratis · Resultado inmediato
          </Text>
        </View>
      </AppScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  mediaContainer: {
    height: 400,
    position: 'relative',
    overflow: 'hidden',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  brandContainer: {
    position: 'absolute',
    top: 24,
    left: 22,
  },
  brandText: {
    letterSpacing: 1.8,
  },
  infoContainer: {
    paddingHorizontal: 26,
    marginTop: -46,
    position: 'relative',
    zIndex: 10,
    backgroundColor: media.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: spacing.lg,
  },
  title: {
    lineHeight: 33,
    marginBottom: spacing.md,
  },
  subtitle: {
    lineHeight: 22,
    marginBottom: spacing.xl,
  },
  hint: {
    textAlign: 'center',
    marginTop: spacing.md,
    marginBottom: spacing.xxl,
  },
});
