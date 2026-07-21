import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { course } from '@/data/mockData';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function ConfirmationScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();

  return (
    <AppScreen contentStyle={styles.screen} edges={['top', 'left', 'right']}>
      <View style={styles.content}>
        <View style={[styles.check, { borderColor: colors.text }]}>
          <Feather name="check" size={54} color={colors.text} />
        </View>
        <Text style={[styles.title, { color: colors.text }]}>¡Pago exitoso!</Text>
        <Text style={[styles.body, { color: colors.textMuted }]}>Ya tienes acceso a{`\n`}{course.title}</Text>
      </View>
      <Button label="Ir al curso" onPress={() => router.replace('/lesson/1' as any)} />
      <Button label="Volver al inicio" variant="secondary" onPress={() => router.replace('/(tabs)/home')} />
      <Text style={[styles.email, { color: colors.textMuted }]}>Te enviamos los detalles a tu email.</Text>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  screen: { padding: spacing.xl, gap: spacing.md, minHeight: '100%' },
  content: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  check: { width: 110, height: 110, borderRadius: 55, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: '900', marginTop: spacing.xl },
  body: { fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: spacing.md },
  email: { fontSize: 11, textAlign: 'center', marginTop: spacing.md },
});
