import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { notify } from '@/lib/confirm';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { useKeyboardOffset } from '@/hooks/useKeyboardOffset';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { ApiError } from '@/services/api';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function RegisterScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const keyboardOffset = useKeyboardOffset();
  const register = useAppStore((state) => state.registerLocalUser);
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const signUpEmail = useAuthStore((state) => state.signUpEmail);

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [hidden, setHidden] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [errors, setErrors] = useState<{ fullName?: string; email?: string; password?: string }>({});

  const submit = async () => {
    const newErrors: { fullName?: string; email?: string; password?: string } = {};

    if (fullName.trim().length < 3) {
      newErrors.fullName = 'El nombre debe tener al menos 3 caracteres';
    }
    if (!email.includes('@')) {
      newErrors.email = 'Introduce un correo electrónico válido';
    }
    if (password.length < 6) {
      newErrors.password = 'La contraseña debe tener al menos 6 caracteres';
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    const cleanName = fullName.trim();
    const cleanEmail = email.trim().toLowerCase();

    // Sin Supabase configurado: se mantiene el flujo demo local.
    if (!supabaseEnabled) {
      register({ fullName: cleanName, email: cleanEmail });
      router.replace('/onboarding');
      return;
    }

    setSubmitting(true);
    try {
      const result = await signUpEmail({ fullName: cleanName, email: cleanEmail, password });
      if (result.needsEmailConfirmation) {
        notify(
          'Confirma tu correo',
          'Te enviamos un enlace de verificación a tu email para activar la cuenta.',
        );
        router.replace('/verification');
      } else {
        router.replace('/onboarding');
      }
    } catch (error) {
      const message =
        error instanceof ApiError || error instanceof Error
          ? error.message
          : 'No se pudo crear la cuenta. Inténtalo de nuevo.';
      if (/already|registrad|exist/i.test(message)) {
        setErrors({ email: 'Este correo ya está registrado' });
      } else {
        notify('No se pudo crear la cuenta', message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const socialDemo = (provider: string) => {
    notify(`${provider} en modo demostración`, 'La autenticación real queda preparada para conectarse con Supabase Auth.');
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.select({ ios: 'padding', android: 'height' })}
        keyboardVerticalOffset={keyboardOffset}
      >
      <AppScreen contentStyle={{ paddingBottom: spacing.xl }}>
        <View style={styles.container}>
          <Text style={[styles.title, { color: colors.text }]}>Crea tu cuenta{`\n`}RENASER</Text>

          <Button
            label="Continuar con Google"
            variant="secondary"
            icon="chrome"
            onPress={() => socialDemo('Google')}
          />
          <Button
            label="Continuar con Apple"
            variant="secondary"
            icon="aperture"
            onPress={() => socialDemo('Apple')}
          />

          <View style={styles.dividerRow}>
            <View style={[styles.line, { backgroundColor: colors.border }]} />
            <Text style={[styles.or, { color: colors.textMuted }]}>o continúa con tu email</Text>
            <View style={[styles.line, { backgroundColor: colors.border }]} />
          </View>

          <Input
            label="Nombre completo"
            value={fullName}
            onChangeText={(t) => {
              setFullName(t);
              setErrors((e) => ({ ...e, fullName: undefined }));
            }}
            placeholder="Juan Pérez"
            error={errors.fullName}
          />

          <Input
            label="Correo electrónico"
            value={email}
            onChangeText={(t) => {
              setEmail(t);
              setErrors((e) => ({ ...e, email: undefined }));
            }}
            placeholder="ejemplo@correo.com"
            keyboardType="email-address"
            autoCapitalize="none"
            error={errors.email}
          />

          <View style={styles.passwordContainer}>
            <Input
              label="Contraseña"
              value={password}
              onChangeText={(t) => {
                setPassword(t);
                setErrors((e) => ({ ...e, password: undefined }));
              }}
              placeholder="Mínimo 6 caracteres"
              secureTextEntry={hidden}
              error={errors.password}
            />
            <Pressable
              onPress={() => setHidden((v) => !v)}
              style={styles.eyeButton}
              accessibilityLabel={hidden ? 'Mostrar contraseña' : 'Ocultar contraseña'}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: !hidden }}
            >
              <Feather name={hidden ? 'eye' : 'eye-off'} size={18} color={colors.textMuted} />
            </Pressable>
          </View>

          <Button label="Crear cuenta" onPress={submit} loading={submitting} style={{ marginTop: spacing.sm }} />

          <Text style={[styles.legal, { color: colors.textMuted }]}>
            Al crear tu cuenta aceptas nuestros Términos y la Política de Privacidad.
          </Text>

          <Pressable onPress={() => router.replace('/login' as never)}>
            <Text style={[styles.login, { color: colors.text }]}>
              ¿Ya tienes cuenta? <Text style={{ fontWeight: '900' }}>Iniciar sesión</Text>
            </Text>
          </Pressable>
        </View>
      </AppScreen>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing.xl, gap: spacing.md },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '900', marginVertical: spacing.lg },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginVertical: spacing.sm },
  line: { height: 1, flex: 1 },
  or: { fontSize: 11 },
  passwordContainer: {
    position: 'relative',
    width: '100%',
  },
  eyeButton: {
    position: 'absolute',
    right: spacing.md,
    top: 36,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  legal: { textAlign: 'center', fontSize: 10, lineHeight: 15, paddingHorizontal: spacing.xl },
  login: { textAlign: 'center', marginTop: spacing.md, fontSize: 13 },
});
