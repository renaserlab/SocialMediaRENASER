import React, { useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { notify } from '@/lib/confirm';
import { rutaTrasAutenticar } from '@/lib/postAuthRoute';
import { useRouter } from 'expo-router';

import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { Aparecer } from '@/components/Aparecer';
import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { CabeceraDeAcceso } from '@/components/CabeceraDeAcceso';
import { CampoDeContrasena } from '@/components/CampoDeContrasena';
import { Input } from '@/components/Input';
import { Pulsable } from '@/components/Pulsable';
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

export function LoginScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const registerLocal = useAppStore((state) => state.registerLocalUser);
  const completeOnboarding = useAppStore((state) => state.setOnboardingComplete);
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const signInEmail = useAuthStore((state) => state.signInEmail);
  const signInWithProvider = useAuthStore((state) => state.signInWithProvider);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [socialBusy, setSocialBusy] = useState(false);

  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  // Evita dos intentos de acceso simultaneos: el segundo llegaba con la sesion
  // del primero ya en curso y podia dejar avisos contradictorios en pantalla.
  const accediendo = useRef(false);
  // «Siguiente» en el teclado del correo lleva a la contraseña.
  const campoDeContrasena = useRef<TextInput>(null);

  const submit = async () => {
    if (accediendo.current) return;
    const newErrors: { email?: string; password?: string } = {};
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
      // Dentro: se nota en la mano antes de que cambie la pantalla.
      haptics.success();
      router.replace((await rutaTrasAutenticar()) as never);
    } catch (error) {
      /*
        Antes se pintaba `error.message` tal cual, y Supabase responde en ingles
        y en jerga («Invalid login credentials», «Email not confirmed»,
        «Failed to fetch»). Ahora se traduce siempre y el original queda en la
        consola.
      */
      const message = mensajeDeAuth(error, 'acceso', t);
      // Las credenciales se corrigen en el propio formulario; el resto son
      // cosas que no dependen de lo escrito y merecen un aviso aparte.
      // Se compara con la CLAVE y no con una palabra del texto: «incorrect»
      // solo casaba en español; en ingles y portugues el error iba al dialogo.
      if (message === t('authError.badCredentials')) {
        setErrors({ password: message });
      } else {
        notify(t('auth.signInFailed'), message);
      }
    } finally {
      accediendo.current = false;
      setSubmitting(false);
    }
  };

  const continueWithGoogle = async () => {
    if (!supabaseEnabled) {
      notify(t('auth.googleUnavailable'), t('auth.googleUnavailableSignIn'));
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
      notify(t('auth.googleFailedSignIn'), mensajeDeAuth(error, 'acceso', t));
    } finally {
      setSocialBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <SinTecladoDelante>
        <AppScreen contentStyle={styles.screen}>
          {/*
            CENTRADO DE VERDAD, no un margen superior a ojo.

            El formulario ocupa poco y antes se quedaba pegado arriba con media
            pantalla vacia debajo. `AppScreen` ya da un contenedor con
            `flexGrow: 1`, asi que basta con que este bloque lo llene
            (`flex: 1`) y reparta el sobrante arriba y abajo
            (`justifyContent: 'center'`). Al abrirse el teclado el alto
            disponible se reduce, el centro se recalcula solo y, si aun asi no
            cabe, la misma vista se desplaza. Sin numeros por telefono.
          */}
          <View style={styles.container}>
            {/*
              LA MARCA, ARRIBA Y EN GRANDE. Antes era un logo de 34 puntos al
              final de la frase «Inicia sesión en»: se leia como una letra
              colgando. Ahora la marca llega una vez, con su muelle, y debajo
              va un saludo. Ver `CabeceraDeAcceso`.
            */}
            <CabeceraDeAcceso titulo={t('auth.signInHello')} subtitulo={t('auth.signInSubtitle')} />

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

            <Aparecer retraso={retrasoEnCascada(2, PASO)}>
              <Input
                forma="destacada"
                icono="mail"
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
                // Que el gestor de contraseñas sepa qué campo es cada uno.
                autoComplete="email"
                textContentType="emailAddress"
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => campoDeContrasena.current?.focus()}
                error={errors.email}
              />
            </Aparecer>

            <Aparecer retraso={retrasoEnCascada(3, PASO)} style={styles.bloque}>
              <CampoDeContrasena
                forma="destacada"
                campoRef={campoDeContrasena}
                label={t('auth.password')}
                value={password}
                onChangeText={(texto) => {
                  setPassword(texto);
                  setErrors((e) => ({ ...e, password: undefined }));
                }}
                placeholder={t('auth.passwordPlaceholder')}
                autoComplete="current-password"
                textContentType="password"
                // «Ir» en el teclado entra, igual que el botón.
                returnKeyType="go"
                onSubmitEditing={() => void submit()}
                error={errors.password}
              />
              {/* Junto al campo al que se refiere, no perdido debajo del botón. */}
              <Pulsable
                onPress={() => router.push('/forgot-password' as never)}
                hitSlop={8}
                style={styles.forgot}
                accessibilityRole="link"
                accessibilityLabel={t('auth.forgot')}
              >
                <Text variant="secondary" weight="700">
                  {t('auth.forgot')}
                </Text>
              </Pulsable>
            </Aparecer>

            <Aparecer retraso={retrasoEnCascada(4, PASO)}>
              <Button
                label={t('auth.signIn')}
                icon="log-in"
                onPress={submit}
                loading={submitting}
                style={styles.principal}
              />
            </Aparecer>

            {/*
              LA OTRA PUERTA ES UN BOTON, no una frase con media palabra en
              negrita: se ve que se puede pulsar y tiene el alto de un dedo.
            */}
            <Aparecer retraso={retrasoEnCascada(5, PASO)} style={styles.pie}>
              <View style={[styles.separador, { backgroundColor: colors.border }]} />
              <Text variant="secondary" color={colors.textMuted} style={styles.centrado}>
                {t('auth.noAccount')}
              </Text>
              <Button
                label={t('auth.signUp')}
                variant="secondary"
                onPress={() => router.replace('/register')}
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
    El centrado va en el CONTENEDOR del desplazamiento, no en un hijo con
    `flex: 1`. La diferencia importa: `flexGrow` solo estira cuando sobra sitio,
    asi que con el formulario corto queda centrado y, cuando el teclado o un
    idioma mas largo lo hacen mas alto que la pantalla, no se comprime: se
    desplaza.
  */
  screen: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xl,
  },
  // Con tope de ancho: en una ventana de escritorio el formulario no se
  // estira de lado a lado, se queda centrado como una columna.
  container: { gap: spacing.lg, width: '100%', maxWidth: 440, alignSelf: 'center' },
  bloque: { gap: spacing.sm },
  forgot: { alignSelf: 'flex-end', minHeight: 32, justifyContent: 'center' },
  principal: { minHeight: 54, marginTop: spacing.xs },
  pie: { gap: spacing.md, marginTop: spacing.sm },
  centrado: { textAlign: 'center' },
  separador: { height: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
  // Los tres de abajo son del bloque de proveedores externos, hoy comentado.
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginVertical: spacing.sm },
  line: { height: 1, flex: 1 },
  or: { fontSize: 11 },
});
