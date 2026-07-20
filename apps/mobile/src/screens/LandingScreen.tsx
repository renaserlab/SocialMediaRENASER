import React from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { assets } from '@/data/assets';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function LandingScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();

  return (
    <View style={{ flex: 1, backgroundColor: '#000000' }}>
      <AppScreen scroll edges={['left', 'right', 'bottom']} style={{ backgroundColor: '#000000' }}>
        <View style={styles.mediaContainer}>
          <Image source={assets.hero} style={styles.image} resizeMode="cover" />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.4)' }]} />
          <View style={styles.brandContainer}>
            <Text variant="body" weight="800" color="#FFFFFF" style={styles.brandText}>
              RENASER
            </Text>
          </View>
        </View>

        <View style={styles.infoContainer}>
          <Text variant="display" color="#FFFFFF" style={styles.title}>
            ¿Qué está bloqueando realmente tu crecimiento?
          </Text>
          <Text variant="body" color="#A8A8AE" style={styles.subtitle}>
            Responde 7 preguntas y descubre tu verdadero límite.
          </Text>
          <Button
            label="Descubrir ahora"
            onPress={() => router.push('/quiz' as any)}
            style={styles.btnInverse}
          />
          <Text variant="secondary" color="#6B6B73" style={styles.hint}>
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
    backgroundColor: '#000000',
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
  btnInverse: {
    backgroundColor: '#FFFFFF',
  },
  hint: {
    textAlign: 'center',
    marginTop: spacing.md,
    marginBottom: spacing.xxl,
  },
});
