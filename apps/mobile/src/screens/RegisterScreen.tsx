import React, { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { notify } from '@/lib/confirm';
import { useRouter } from 'expo-router';

import { rutaTrasAutenticar } from '@/lib/postAuthRoute';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { useKeyboardOffset } from '@/hooks/useKeyboardOffset';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { ZLogo } from '@/components/ZLogo';
import { mensajeDeAuth } from '@/lib/authErrors';
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
  const signInWithProvider = useAuthStore((state) => state.signInWithProvider);

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [hidden, setHidden] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [socialBusy, setSocialBusy] = useState(false);

  const [errors, setErrors] = useState<{ fullName?: string; email?: string; password?: string }>({});
  // Sin este cerrojo, un doble toque lanzaba dos altas: la segunda respondia
  // «ese correo ya tiene una cuenta» —la que acababa de crear la primera— y
  // parecia que el registro habia fallado cuando en realidad habia funcionado.
  const creando = useRef(false);

  const submit = async () => {
    if (creando.current) return;
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
      // Sin servidor no hay donde guardar lo que responda el cuestionario.
      router.replace('/(tabs)/home');
      return;
    }

    creando.current = true;
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
        // Cuenta recien creada: le toca el cuestionario, salvo que la
        // personalizacion este apagada en el servidor.
        router.replace((await rutaTrasAutenticar()) as never);
      }
    } catch (error) {
      // Igual que en el acceso: el texto tecnico de Supabase no llega a la
      // pantalla, solo a la consola.
      const message = mensajeDeAuth(error, 'registro');
      if (/ya tiene una cuenta/i.test(message)) {
        setErrors({ email: 'Ese correo ya tiene una cuenta' });
      } else {
        notify('No se pudo crear la cuenta', message);
      }
    } finally {
      creando.current = false;
      setSubmitting(false);
    }
  };

  /** Con Google no hay "registro" aparte: el primer acceso crea la cuenta. */
  const continueWithGoogle = async () => {
    if (!supabaseEnabled) {
      notify('Google no disponible', 'Conecta Supabase para crear tu cuenta con Google.');
      return;
    }
    setSocialBusy(true);
    try {
      await signInWithProvider('google');
      if (useAuthStore.getState().status === 'authenticated') {
        router.replace((await rutaTrasAutenticar()) as never);
      }
    } catch (error) {
      notify('No se pudo continuar con Google', mensajeDeAuth(error, 'registro'));
    } finally {
      setSocialBusy(false);
    }
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
            {/*
              La marca se pinta con su logo y en la MISMA linea. Antes llevaba
              un salto y la «Z» iba escrita con la tipografia del texto: se
              leia como una letra suelta colgando debajo, no como el nombre
              del producto.
            */}
            <View style={styles.titleRow}>
              <Text style={[styles.title, { color: colors.text }]}>Crea tu cuenta</Text>
              <ZLogo size={34} />
            </View>

            {/*
            Oculto igual que en LoginScreen: el flujo de Google esta listo,
            falta activarlo en Supabase. Descomentar para reactivarlo.

          <Button
            label="Continuar con Google"
            variant="secondary"
            icon="chrome"
            loading={socialBusy}
            onPress={() => void continueWithGoogle()}
          />

          <View style={styles.dividerRow}>
            <View style={[styles.line, { backgroundColor: colors.border }]} />
            <Text style={[styles.or, { color: colors.textMuted }]}>o continúa con tu email</Text>
            <View style={[styles.line, { backgroundColor: colors.border }]} />
          </View>
          */}

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
  title: { fontSize: 24, lineHeight: 30, fontWeight: '900' },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    // Si el idioma alarga el texto, el logo baja en vez de salirse.
    flexWrap: 'wrap',
    marginVertical: spacing.lg,
  },
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
