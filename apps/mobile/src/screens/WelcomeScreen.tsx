import React from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { assets } from '@/data/assets';
import { palette, radius, spacing } from '@/theme/tokens';


// Portada intencionalmente oscura en ambos temas, como la landing.
const media = palette('dark');

/** Lo que el usuario se lleva al entrar; se explica antes de pedirle nada. */
const PUNTOS: Array<{ icon: keyof typeof Feather.glyphMap; text: string }> = [
  { icon: 'lock', text: 'Espacio privado: solo miembros' },
  { icon: 'compass', text: 'Contenido guiado por Z' },
  { icon: 'users', text: 'Una comunidad que avanza contigo' },
];

/**
 * Bienvenida antes del quiz.
 *
 * Va entre la landing y las preguntas para dar contexto: quien entra sabe
 * donde esta y por que se le va a preguntar, en vez de caer directo en un
 * cuestionario.
 */
export function WelcomeScreen() {
  const router = useRouter();

  return (
    <View style={{ flex: 1, backgroundColor: media.background }}>
      <AppScreen scroll edges={['left', 'right', 'bottom']}>
        <View style={styles.hero}>
          <Image source={assets.hero} style={StyleSheet.absoluteFill} resizeMode="cover" />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: media.overlay }]} />
          <View style={styles.brand}>
            <Text variant="body" weight="800" color={media.text} style={styles.brandText}>
              Z
            </Text>
          </View>
        </View>

        <View style={styles.body}>
          <Text variant="display" color={media.text} style={styles.title}>
            Bienvenido a Z
          </Text>
          <Text variant="body" color={media.textMuted} style={styles.subtitle}>
            Esta es una plataforma privada. Un espacio para crecer con
            acompañamiento, sin ruido y a tu ritmo.
          </Text>

          <View style={styles.points}>
            {PUNTOS.map((punto) => (
              <View key={punto.text} style={styles.point}>
                <View style={[styles.pointIcon, { borderColor: media.textMuted }]}>
                  <Feather name={punto.icon} size={17} color={media.text} />
                </View>
                <Text variant="body" color={media.text} style={{ flex: 1 }}>
                  {punto.text}
                </Text>
              </View>
            ))}
          </View>

          <Button
            label="Comenzar"
            variant="secondary"
            onPress={() => router.push('/register' as never)}
            style={styles.cta}
          />
          <Text variant="secondary" color={media.textMuted} style={styles.hint}>
            Antes de entrar, explora este mundo.
          </Text>
        </View>
      </AppScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { height: 260, position: 'relative', overflow: 'hidden' },
  brand: { position: 'absolute', top: 24, left: 22 },
  brandText: { letterSpacing: 1.8 },
  body: {
    paddingHorizontal: 26,
    marginTop: -34,
    backgroundColor: media.background,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingTop: spacing.xl,
  },
  title: { lineHeight: 34, marginBottom: spacing.md },
  subtitle: { lineHeight: 22, marginBottom: spacing.xl },
  points: { gap: spacing.lg, marginBottom: spacing.xxl },
  point: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  pointIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cta: { width: '100%' },
  hint: { textAlign: 'center', marginTop: spacing.md, marginBottom: spacing.xxl },
});
