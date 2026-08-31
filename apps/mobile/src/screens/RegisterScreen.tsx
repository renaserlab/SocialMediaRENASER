import React, { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { notify } from '@/lib/confirm';
import { useRouter } from 'expo-router';

import { rutaTrasAutenticar } from '@/lib/postAuthRoute';
import { Feather } from '@expo/vector-icons';

import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { ZLogo } from '@/components/ZLogo';
import { useTranslation } from '@/i18n/useTranslation';
import { mensajeDeAuth } from '@/lib/authErrors';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function RegisterScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
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
      newErrors.fullName = t('auth.errorName');
    }
    if (!email.includes('@')) {
      newErrors.email = t('auth.errorEmail');
    }
    if (password.length < 6) {
      newErrors.password = t('auth.errorPassword');
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
        notify(t('auth.confirmEmail'), t('auth.confirmEmailBody'));
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
        setErrors({ email: t('auth.errorEmailTaken') });
      } else {
        notify(t('auth.signUpFailed'), message);
      }
    } finally {
      creando.current = false;
      setSubmitting(false);
    }
  };

  /** Con Google no hay "registro" aparte: el primer acceso crea la cuenta. */
  const continueWithGoogle = async () => {
    if (!supabaseEnabled) {
      notify(t('auth.googleUnavailable'), t('auth.googleUnavailableSignUp'));
      return;
    }
    setSocialBusy(true);
    try {
      await signInWithProvider('google');
      if (useAuthStore.getState().status === 'authenticated') {
        router.replace((await rutaTrasAutenticar()) as never);
      }
    } catch (error) {
      notify(t('auth.googleFailedSignUp'), mensajeDeAuth(error, 'registro'));
    } finally {
      setSocialBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <SinTecladoDelante>
        <AppScreen contentStyle={styles.screen}>
          {/* Mismo criterio que en el acceso: centrado con flexbox, sin margen
              superior fijo. Ver `styles.screen`. */}
          <View style={styles.container}>
            {/*
              La marca se pinta con su logo y en la MISMA linea. Antes llevaba
              un salto y la «Z» iba escrita con la tipografia del texto: se
              leia como una letra suelta colgando debajo, no como el nombre
              del producto.
            */}
            <View style={styles.titleRow}>
              <Text style={[styles.title, { color: colors.text }]}>{t('auth.signUpTitle')}</Text>
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
              label={t('auth.fullName')}
              value={fullName}
              onChangeText={(texto) => {
                setFullName(texto);
                setErrors((e) => ({ ...e, fullName: undefined }));
              }}
              placeholder={t('auth.fullNamePlaceholder')}
              error={errors.fullName}
            />

            <Input
              label={t('auth.email')}
              value={email}
              onChangeText={(texto) => {
                setEmail(texto);
                setErrors((e) => ({ ...e, email: undefined }));
              }}
              placeholder={t('auth.emailPlaceholder')}
              keyboardType="email-address"
              autoCapitalize="none"
              error={errors.email}
            />

            <View style={styles.passwordContainer}>
              <Input
                label={t('auth.password')}
                value={password}
                onChangeText={(texto) => {
                  setPassword(texto);
                  setErrors((e) => ({ ...e, password: undefined }));
                }}
                placeholder={t('auth.passwordPlaceholderNew')}
                secureTextEntry={hidden}
                error={errors.password}
              />
              <Pressable
                onPress={() => setHidden((v) => !v)}
                style={styles.eyeButton}
                accessibilityLabel={hidden ? t('auth.showPassword') : t('auth.hidePassword')}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: !hidden }}
              >
                <Feather name={hidden ? 'eye' : 'eye-off'} size={18} color={colors.textMuted} />
              </Pressable>
            </View>

            <Button
              label={t('auth.signUp')}
              onPress={submit}
              loading={submitting}
              style={{ marginTop: spacing.sm }}
            />

            <Text style={[styles.legal, { color: colors.textMuted }]}>{t('auth.legal')}</Text>

            <Pressable onPress={() => router.replace('/login' as never)}>
              <Text style={[styles.login, { color: colors.text }]}>
                {t('auth.haveAccount')}{' '}
                <Text style={{ fontWeight: '900' }}>{t('auth.signIn')}</Text>
              </Text>
            </Pressable>
          </View>
        </AppScreen>
      </SinTecladoDelante>
    </View>
  );
}

const styles = StyleSheet.create({
  /*
    Igual que en el acceso: el centrado vive en el contenedor del
    desplazamiento (`flexGrow` + `justifyContent`), nunca en un hijo con
    `flex: 1`, para que al crecer el contenido se desplace en vez de
    comprimirse. Ver `LoginScreen`.
  */
  screen: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xl,
  },
  container: { gap: spacing.md },
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
