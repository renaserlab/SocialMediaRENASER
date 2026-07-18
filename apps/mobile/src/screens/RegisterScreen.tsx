import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { PrimaryButton } from '@/components/PrimaryButton';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function RegisterScreen() {
  const { colors } = useAppTheme();
  const register = useAppStore((state) => state.registerLocalUser);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [hidden, setHidden] = useState(true);

  const submit = () => {
    if (fullName.trim().length < 3 || !email.includes('@') || password.length < 6) {
      Alert.alert('Revisa tus datos', 'Ingresa nombre, correo válido y una contraseña de al menos 6 caracteres.');
      return;
    }
    register({ fullName: fullName.trim(), email: email.trim().toLowerCase() });
    router.replace('/onboarding');
  };

  const socialDemo = (provider: string) => {
    Alert.alert(`${provider} en modo demostración`, 'La autenticación real queda preparada para conectarse con Supabase Auth.');
  };

  return (
    <AppScreen contentStyle={{ paddingBottom: spacing.xl }}>
      <AppHeader back title="" />
      <View style={styles.container}>
        <Text style={[styles.title, { color: colors.text }]}>Crea tu cuenta{`\n`}RENASER</Text>
        <PrimaryButton label="Continuar con Google" variant="secondary" onPress={() => socialDemo('Google')} />
        <PrimaryButton label="Continuar con Apple" variant="secondary" onPress={() => socialDemo('Apple')} />

        <View style={styles.dividerRow}>
          <View style={[styles.line, { backgroundColor: colors.border }]} />
          <Text style={[styles.or, { color: colors.textMuted }]}>o continúa con tu email</Text>
          <View style={[styles.line, { backgroundColor: colors.border }]} />
        </View>

        <TextInput
          value={fullName}
          onChangeText={setFullName}
          placeholder="Nombre completo"
          placeholderTextColor={colors.textMuted}
          style={[styles.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
        />
        <TextInput
          value={email}
          onChangeText={setEmail}
          placeholder="Email"
          keyboardType="email-address"
          autoCapitalize="none"
          placeholderTextColor={colors.textMuted}
          style={[styles.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
        />
        <View style={[styles.passwordRow, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="Contraseña"
            secureTextEntry={hidden}
            placeholderTextColor={colors.textMuted}
            style={[styles.passwordInput, { color: colors.text }]}
          />
          <Pressable onPress={() => setHidden((value) => !value)}>
            <Ionicons name={hidden ? 'eye-outline' : 'eye-off-outline'} size={20} color={colors.textMuted} />
          </Pressable>
        </View>

        <PrimaryButton label="Crear cuenta" onPress={submit} style={{ marginTop: spacing.sm }} />
        <Text style={[styles.legal, { color: colors.textMuted }]}>Al crear tu cuenta aceptas nuestros Términos y la Política de Privacidad.</Text>
        <Pressable onPress={() => socialDemo('Inicio de sesión')}>
          <Text style={[styles.login, { color: colors.text }]}>¿Ya tienes cuenta? <Text style={{ fontWeight: '900' }}>Iniciar sesión</Text></Text>
        </Pressable>
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing.xl, gap: spacing.md },
  title: { fontSize: 31, lineHeight: 36, fontWeight: '900', marginVertical: spacing.xl },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginVertical: spacing.sm },
  line: { height: 1, flex: 1 },
  or: { fontSize: 11 },
  input: { height: 54, borderRadius: radius.md, borderWidth: 1, paddingHorizontal: spacing.lg, fontSize: 15 },
  passwordRow: { height: 54, borderRadius: radius.md, borderWidth: 1, paddingHorizontal: spacing.lg, flexDirection: 'row', alignItems: 'center' },
  passwordInput: { flex: 1, height: '100%', fontSize: 15 },
  legal: { textAlign: 'center', fontSize: 10, lineHeight: 15, paddingHorizontal: spacing.xl },
  login: { textAlign: 'center', marginTop: spacing.md, fontSize: 13 },
});
