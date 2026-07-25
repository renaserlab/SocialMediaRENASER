import React from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
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
              Z
            </Text>
          </View>
        </View>

        <View style={styles.infoContainer}>
          <Text variant="display" color={media.text} style={styles.title}>
            ¿Qué está bloqueando realmente tu crecimiento?
          </Text>

          {/*<Text variant="body" color={media.textMuted} style={styles.subtitle}>
            Responde 7 preguntas y descubre tu verdadero límite.
          </Text>*/}

          <Button
            label="Descubrir ahora"
            variant="secondary"
            // Pasa por la bienvenida: explica que RENASER es privado antes de
            // soltar al visitante en las 7 preguntas.
            onPress={() => router.push('/welcome' as any)}
          />
          <Text variant="secondary" color={media.textMuted} style={styles.hint}>

          </Text>

          {/*
            Salida para quien YA tiene cuenta: sin esto, alguien que solo cerro
            sesion tenia que responder las 7 preguntas y llegar al registro para
            encontrar el enlace de iniciar sesion.
          */}
          <Pressable
            onPress={() => router.push('/login' as never)}
            accessibilityRole="button"
            accessibilityLabel="Iniciar sesión"
            hitSlop={8}
            style={({ pressed }) => [styles.loginRow, { opacity: pressed ? 0.7 : 1 }]}
          >
            <Text variant="secondary" color={media.textMuted}>
              ¿Ya tienes cuenta?{' '}
            </Text>
            <Text variant="secondary" weight="700" color={media.text}>
              Iniciar sesión
            </Text>
          </Pressable>
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
    marginBottom: spacing.lg,
  },
  loginRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.xxl,
    minHeight: 44,
  },
});
