import React, { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { notify } from '@/lib/confirm';
import { rutaTrasAutenticar } from '@/lib/postAuthRoute';
import { useRouter } from 'expo-router';
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

export function LoginScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const keyboardOffset = useKeyboardOffset();
  const registerLocal = useAppStore((state) => state.registerLocalUser);
  const completeOnboarding = useAppStore((state) => state.setOnboardingComplete);
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const signInEmail = useAuthStore((state) => state.signInEmail);
  const signInWithProvider = useAuthStore((state) => state.signInWithProvider);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [hidden, setHidden] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [socialBusy, setSocialBusy] = useState(false);

  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  // Evita dos intentos de acceso simultaneos: el segundo llegaba con la sesion
  // del primero ya en curso y podia dejar avisos contradictorios en pantalla.
  const accediendo = useRef(false);

  const submit = async () => {
    if (accediendo.current) return;
    const newErrors: { email?: string; password?: string } = {};
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

    const cleanEmail = email.trim().toLowerCase();

    // Sin Supabase configurado: acceso demo local.
    if (!supabaseEnabled) {
      const name = cleanEmail.split('@')[0] ?? 'Usuario';
      registerLocal({ fullName: name, email: cleanEmail });
      completeOnboarding(true);
      router.replace('/(tabs)/home');
      return;
    }

    accediendo.current = true;
    setSubmitting(true);
    try {
      await signInEmail({ email: cleanEmail, password });
      router.replace((await rutaTrasAutenticar()) as never);
    } catch (error) {
      /*
        Antes se pintaba `error.message` tal cual, y Supabase responde en ingles
        y en jerga («Invalid login credentials», «Email not confirmed»,
        «Failed to fetch»). Ahora se traduce siempre y el original queda en la
        consola.
      */
      const message = mensajeDeAuth(error, 'acceso');
      // Las credenciales se corrigen en el propio formulario; el resto son
      // cosas que no dependen de lo escrito y merecen un aviso aparte.
      if (/incorrect/i.test(message)) {
        setErrors({ password: message });
      } else {
        notify('No se pudo iniciar sesión', message);
      }
    } finally {
      accediendo.current = false;
      setSubmitting(false);
    }
  };

  const continueWithGoogle = async () => {
    if (!supabaseEnabled) {
      notify('Google no disponible', 'Conecta Supabase para acceder con Google.');
      return;
    }
    setSocialBusy(true);
    try {
      await signInWithProvider('google');
      // En web la pagina se redirige sola; en nativo ya hay sesion al volver.
      if (useAuthStore.getState().status === 'authenticated') {
        router.replace((await rutaTrasAutenticar()) as never);
      }
    } catch (error) {
      notify('No se pudo acceder con Google', mensajeDeAuth(error, 'acceso'));
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
              <Text style={[styles.title, { color: colors.text }]}>Inicia sesión en</Text>
              <ZLogo size={34} />
            </View>

            {/*
            ACCESO CON PROVEEDORES EXTERNOS — oculto a proposito.

            NO DESCOMENTAR sin antes tener las credenciales. Que este oculto es
            lo que hoy protege el envio a la App Store, no una carencia:

            - Un boton que falla al pulsarlo es rechazo por «app incompleta»
              (directriz 2.1). Google no tiene credenciales en Supabase.
            - Ofrecer un login social de terceros ACTIVA la directriz 4.8, que
              obliga a ofrecer tambien Sign in with Apple. Mientras aqui no se
              muestre ninguno, esa exigencia no aplica y la app puede subirse
              solo con correo y contrasena.

            Google: el flujo esta implementado y probado (ver
            AuthRepository.signInWithProvider). Solo falta activar el proveedor
            en Supabase y pegar las credenciales de Google Cloud.

            Apple: ademas de lo anterior, exige el Apple Developer Program para
            registrar el Service ID, y la dependencia nativa
            expo-apple-authentication (hoy no instalada) para usar su boton.

            Orden correcto para encenderlo: credenciales primero, los dos
            proveedores despues y a la vez. Nunca uno solo.

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
                placeholder="Tu contraseña"
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

            <Button label="Iniciar sesión" onPress={submit} loading={submitting} style={{ marginTop: spacing.sm }} />
            <Pressable
              onPress={() => router.push('/forgot-password' as never)}
              style={styles.forgot}
              accessibilityRole="button"
              accessibilityLabel="Olvidé mi contraseña"
            >
              <Text style={[styles.forgotText, { color: colors.textMuted }]}>
                ¿Olvidaste tu contraseña?
              </Text>
            </Pressable>

            <Pressable onPress={() => router.replace('/register')}>
              <Text style={[styles.login, { color: colors.text }]}>
                ¿No tienes cuenta? <Text style={{ fontWeight: '900' }}>Crear cuenta</Text>
              </Text>
            </Pressable>
          </View>
        </AppScreen>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  forgot: { alignSelf: 'center', paddingVertical: spacing.md },
  forgotText: { fontSize: 13, fontWeight: '600' },
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
  login: { textAlign: 'center', marginTop: spacing.md, fontSize: 13 },
});
