import React from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { assets } from '@/data/assets';
import { palette, radius, spacing } from '@/theme/tokens';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';


// Portada intencionalmente oscura en ambos temas, como la landing.
const media = palette('dark');

/** Lo que el usuario se lleva al entrar; se explica antes de pedirle nada. */
// La etiqueta se guarda como CLAVE: el texto se resuelve al pintar, que es
// cuando se sabe en que idioma esta la aplicacion.
const PUNTOS: Array<{ icon: keyof typeof Feather.glyphMap; clave: TranslationKey }> = [
  { icon: 'lock', clave: 'welcome.point1' },
  { icon: 'compass', clave: 'welcome.point2' },
  { icon: 'users', clave: 'welcome.point3' },
];

/**
 * Bienvenida antes del quiz.
 *
 * Va entre la landing y las preguntas para dar contexto: quien entra sabe
 * donde esta y por que se le va a preguntar, en vez de caer directo en un
 * cuestionario.
 */
export function WelcomeScreen() {
  const { t } = useTranslation();
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
            {t('welcome.title')}
          </Text>
          <Text variant="body" color={media.textMuted} style={styles.subtitle}>
            {t('welcome.subtitle')}
          </Text>

          <View style={styles.points}>
            {PUNTOS.map((punto) => (
              <View key={punto.clave} style={styles.point}>
                <View style={[styles.pointIcon, { borderColor: media.textMuted }]}>
                  <Feather name={punto.icon} size={17} color={media.text} />
                </View>
                <Text variant="body" color={media.text} style={{ flex: 1 }}>
                  {t(punto.clave)}
                </Text>
              </View>
            ))}
          </View>

          <Button
            label={t('welcome.start')}
            variant="secondary"
            onPress={() => router.push('/register' as never)}
            style={styles.cta}
          />
          <Text variant="secondary" color={media.textMuted} style={styles.hint}>
            {t('welcome.hint')}
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
