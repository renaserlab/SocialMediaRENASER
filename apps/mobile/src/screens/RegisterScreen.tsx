import React, { useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { notify } from '@/lib/confirm';
import { useRouter } from 'expo-router';

import { rutaTrasAutenticar } from '@/lib/postAuthRoute';
import { Feather } from '@expo/vector-icons';

import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { Aparecer } from '@/components/Aparecer';
import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { CabeceraDeAcceso } from '@/components/CabeceraDeAcceso';
import { CampoDeContrasena } from '@/components/CampoDeContrasena';
import { IconoQueSeEnciende } from '@/components/IconoQueSeEnciende';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import { mensajeDeAuth } from '@/lib/authErrors';
import { haptics } from '@/lib/haptics';
import { retrasoEnCascada } from '@/lib/movimiento';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/** Lo que tarda en entrar cada bloque respecto al anterior. */
const PASO = 50;
/** La longitud mínima de la contraseña. La misma que valida `submit`. */
const MINIMO_DE_CONTRASENA = 6;

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
  const [submitting, setSubmitting] = useState(false);
  const [socialBusy, setSocialBusy] = useState(false);

  const [errors, setErrors] = useState<{ fullName?: string; email?: string; password?: string }>({});
  // Sin este cerrojo, un doble toque lanzaba dos altas: la segunda respondia
  // «ese correo ya tiene una cuenta» —la que acababa de crear la primera— y
  // parecia que el registro habia fallado cuando en realidad habia funcionado.
  const creando = useRef(false);
  // «Siguiente» en el teclado recorre los campos en orden.
  const campoDeCorreo = useRef<TextInput>(null);
  const campoDeContrasena = useRef<TextInput>(null);

  const contrasenaSuficiente = password.length >= MINIMO_DE_CONTRASENA;

  const submit = async () => {
    if (creando.current) return;
    const newErrors: { fullName?: string; email?: string; password?: string } = {};

    if (fullName.trim().length < 3) {
      newErrors.fullName = t('auth.errorName');
    }
    if (!email.includes('@')) {
      newErrors.email = t('auth.errorEmail');
    }
    if (password.length < MINIMO_DE_CONTRASENA) {
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
      // La cuenta existe: se nota en la mano antes de que cambie la pantalla.
      haptics.success();
      if (result.needsEmailConfirmation) {
        notify(t('auth.confirmEmail'), t('auth.confirmEmailBody'));
        // Al acceso, que es donde se entra tras pulsar el enlace del correo.
        // `/verification` es la insignia de membresia, no un «revisa tu correo».
        router.replace('/login');
      } else {
        // Cuenta recien creada: le toca el cuestionario, salvo que la
        // personalizacion este apagada en el servidor.
        router.replace((await rutaTrasAutenticar()) as never);
      }
    } catch (error) {
      // Igual que en el acceso: el texto tecnico de Supabase no llega a la
      // pantalla, solo a la consola.
      const message = mensajeDeAuth(error, 'registro', t);
      // Se compara con la CLAVE, no con palabras del texto: una expresion en
      // español no casaba en ingles ni en portugues y el aviso salia en dialogo.
      if (message === t('authError.emailTaken')) {
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
      notify(t('auth.googleFailedSignUp'), mensajeDeAuth(error, 'registro', t));
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
            {/* La marca arriba, como en el acceso; algo menor porque aquí hay
                un campo más. Ver `CabeceraDeAcceso`. */}
            <CabeceraDeAcceso
              titulo={t('auth.signUpTitle')}
              subtitulo={t('auth.signUpSubtitle')}
              tamano={60}
            />

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

            <Aparecer retraso={retrasoEnCascada(2, PASO)}>
              <Input
                forma="destacada"
                icono="user"
                label={t('auth.fullName')}
                value={fullName}
                onChangeText={(texto) => {
                  setFullName(texto);
                  setErrors((e) => ({ ...e, fullName: undefined }));
                }}
                placeholder={t('auth.fullNamePlaceholder')}
                autoCapitalize="words"
                autoComplete="name"
                textContentType="name"
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => campoDeCorreo.current?.focus()}
                error={errors.fullName}
              />
            </Aparecer>

            <Aparecer retraso={retrasoEnCascada(3, PASO)}>
              <Input
                forma="destacada"
                icono="mail"
                campoRef={campoDeCorreo}
                label={t('auth.email')}
                value={email}
                onChangeText={(texto) => {
                  setEmail(texto);
                  setErrors((e) => ({ ...e, email: undefined }));
                }}
                placeholder={t('auth.emailPlaceholder')}
                keyboardType="email-address"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                textContentType="emailAddress"
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => campoDeContrasena.current?.focus()}
                error={errors.email}
              />
            </Aparecer>

            <Aparecer retraso={retrasoEnCascada(4, PASO)} style={styles.bloque}>
              <CampoDeContrasena
                forma="destacada"
                campoRef={campoDeContrasena}
                label={t('auth.password')}
                value={password}
                onChangeText={(texto) => {
                  setPassword(texto);
                  setErrors((e) => ({ ...e, password: undefined }));
                }}
                placeholder={t('auth.passwordCreate')}
                // `new-password`: el gestor ofrece generar una, no rellenar la vieja.
                autoComplete="new-password"
                textContentType="newPassword"
                returnKeyType="go"
                onSubmitEditing={() => void submit()}
                error={errors.password}
              />
              {/*
                EL REQUISITO, A LA VISTA Y EN VIVO. Antes solo estaba en el
                texto de ejemplo, que desaparece al escribir la primera letra:
                la regla se conocia al fallar. Ahora se cumple delante de quien
                escribe. No depende del color: el icono cambia de un circulo
                vacio a uno marcado. Con el error puesto se calla, porque el
                error dice lo mismo.
              */}
              {errors.password ? null : (
                <View style={styles.requisito}>
                  <IconoQueSeEnciende activo={contrasenaSuficiente}>
                    <Feather
                      name={contrasenaSuficiente ? 'check-circle' : 'circle'}
                      size={14}
                      color={contrasenaSuficiente ? colors.success : colors.textMuted}
                    />
                  </IconoQueSeEnciende>
                  <Text
                    variant="secondary"
                    color={contrasenaSuficiente ? colors.text : colors.textMuted}
                  >
                    {t('auth.passwordPlaceholderNew')}
                  </Text>
                </View>
              )}
            </Aparecer>

            <Aparecer retraso={retrasoEnCascada(5, PASO)} style={styles.bloque}>
              <Button
                label={t('auth.signUp')}
                icon="user-plus"
                onPress={submit}
                loading={submitting}
                style={styles.principal}
              />
              {/*
                Los dos documentos se pueden LEER desde aquí: antes la frase los
                nombraba sin enlazarlos, en letra de 10 puntos. Se abren encima
                y al volver el formulario sigue como estaba.
              */}
              <Text variant="secondary" color={colors.textMuted} style={styles.legal}>
                {t('auth.legalBefore')}{' '}
                <Text
                  variant="secondary"
                  weight="700"
                  accessibilityRole="link"
                  onPress={() => router.push('/terms' as never)}
                  style={styles.enlace}
                >
                  {t('auth.legalTerms')}
                </Text>{' '}
                {t('auth.legalAnd')}{' '}
                <Text
                  variant="secondary"
                  weight="700"
                  accessibilityRole="link"
                  onPress={() => router.push('/privacy' as never)}
                  style={styles.enlace}
                >
                  {t('auth.legalPrivacy')}
                </Text>
                .
              </Text>
            </Aparecer>

            <Aparecer retraso={retrasoEnCascada(6, PASO)} style={styles.pie}>
              <View style={[styles.separador, { backgroundColor: colors.border }]} />
              <Text variant="secondary" color={colors.textMuted} style={styles.centrado}>
                {t('auth.haveAccount')}
              </Text>
              <Button
                label={t('auth.signIn')}
                variant="secondary"
                onPress={() => router.replace('/login' as never)}
              />
            </Aparecer>
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
  container: { gap: spacing.lg, width: '100%', maxWidth: 440, alignSelf: 'center' },
  bloque: { gap: spacing.sm },
  requisito: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  principal: { minHeight: 54, marginTop: spacing.xs },
  legal: { textAlign: 'center', paddingHorizontal: spacing.md },
  // Subrayado: que se vea que es un enlace sin depender del peso de la letra.
  enlace: { textDecorationLine: 'underline' },
  pie: { gap: spacing.md, marginTop: spacing.sm },
  centrado: { textAlign: 'center' },
  separador: { height: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
  // Los tres de abajo son del bloque de proveedores externos, hoy comentado.
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginVertical: spacing.sm },
  line: { height: 1, flex: 1 },
  or: { fontSize: 11 },
});
