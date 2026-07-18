import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '@/components/AppScreen';
import { PrimaryButton } from '@/components/PrimaryButton';
import { course } from '@/data/mockData';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function ConfirmationScreen() {
  const { colors } = useAppTheme();
  return (
    <AppScreen contentStyle={styles.screen}>
      <View style={styles.content}>
        <View style={[styles.check, { borderColor: colors.text }]}>
          <Ionicons name="checkmark" size={58} color={colors.text} />
        </View>
        <Text style={[styles.title, { color: colors.text }]}>¡Pago exitoso!</Text>
        <Text style={[styles.body, { color: colors.textMuted }]}>Ya tienes acceso a{`\n`}{course.title}</Text>
      </View>
      <PrimaryButton label="Ir al curso" onPress={() => router.replace('/course/lider-vida-empresa')} />
      <PrimaryButton label="Volver al inicio" variant="secondary" onPress={() => router.replace('/(tabs)/home')} />
      <Text style={[styles.email, { color: colors.textMuted }]}>Te enviamos los detalles a tu email.</Text>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  screen: { padding: spacing.xl, gap: spacing.md },
  content: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  check: { width: 130, height: 130, borderRadius: 65, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 31, fontWeight: '900', marginTop: spacing.xxl },
  body: { fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: spacing.md },
  email: { fontSize: 11, textAlign: 'center', marginTop: spacing.md },
});
