import React, { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';

import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import { mensajeDeAuth } from '@/lib/authErrors';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/** Pide el correo y envía el enlace para restablecer la contraseña. */
export function ForgotPasswordScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const requestPasswordReset = useAuthStore((state) => state.requestPasswordReset);
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);

  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
    Cerrojo contra el doble envio.

    `sending` no basta: es estado de React y no cambia hasta el siguiente
    dibujado, asi que dos pulsaciones en el mismo instante entran las dos. Pasa
    de verdad —un doble toque, o un clic que dispara puntero y raton— y la
    consecuencia era mala de un modo poco evidente: el primer correo se enviaba
    bien, el segundo chocaba con el limite de envios de Supabase y su error
    BORRABA la pantalla de «revisa tu correo». El usuario leia que habia
    fallado, con el mensaje ya en su bandeja, y volvia a intentarlo.

    Un `ref` se actualiza en el acto, asi que la segunda llamada se descarta.
  */
  const enviando = useRef(false);

  const submit = async () => {
    if (enviando.current) return;
    const clean = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(clean)) {
      setError(t('auth.errorEmailFormat'));
      return;
    }
    if (!supabaseEnabled) {
      setError(t('auth.resetNeedsServer'));
      return;
    }
    enviando.current = true;
    setSending(true);
    setError(null);
    try {
      await requestPasswordReset(clean);
      setSent(true);
    } catch (err) {
      /*
        El fallo de Supabase llega en ingles y describe la averia del servidor
        («Unable to validate email address: invalid format», «Failed to fetch»,
        «AuthApiError»). Escrito en rojo debajo del campo parecia que la
        aplicacion se hubiera roto. El detalle tecnico entero queda en la
        consola; aqui solo se dice que ha pasado y que se puede hacer.
      */
      setError(mensajeDeAuth(err, 'recuperacion', t));
    } finally {
      enviando.current = false;
      setSending(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title=""
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/login'))}
      />
      <SinTecladoDelante>
        <AppScreen contentStyle={styles.screen}>
          {sent ? (
            /*
              Se confirma sin decir si el correo existe o no: revelarlo permitiria
              averiguar quien tiene cuenta en la app.
            */
            <View style={styles.done}>
              <View style={[styles.icon, { borderColor: colors.border }]}>
                <Feather name="mail" size={30} color={colors.text} />
              </View>
              <Text variant="title" weight="900" style={styles.centered}>
                {t('auth.checkEmail')}
              </Text>
              {/*
                La frase entera es UNA clave con el correo dentro: antes iba
                partida en tres trozos alrededor del `<Text weight="700">` y el
                orden de las palabras cambia con el idioma, asi que traducida se
                rompia. Se pierde la negrita del correo; a cambio la frase se
                puede escribir bien en cualquier idioma.
              */}
              <Text variant="body" color={colors.textMuted} style={styles.centered}>
                {t('auth.checkEmailBody', { email: email.trim().toLowerCase() })}
              </Text>
              <Text variant="secondary" color={colors.textMuted} style={styles.centered}>
                {t('auth.checkSpam')}
              </Text>
              <Button
                label={t('auth.backToSignIn')}
                onPress={() => router.replace('/login')}
                style={styles.action}
              />
              <Button
                label={t('auth.sendToAnother')}
                variant="ghost"
                onPress={() => {
                  setSent(false);
                  setEmail('');
                }}
              />
            </View>
          ) : (
            <>
              <Text variant="title" weight="900" style={styles.title}>
                {t('auth.forgot')}
              </Text>
              <Text variant="body" color={colors.textMuted} style={styles.subtitle}>
                {t('auth.forgotBody')}
              </Text>

              <Input
                // La misma caja que en el acceso, de donde se viene.
                forma="destacada"
                icono="mail"
                inputMode="email"
                autoCorrect={false}
                label={t('auth.email')}
                value={email}
                onChangeText={(texto) => {
                  setEmail(texto);
                  setError(null);
                }}
                placeholder={t('auth.emailPlaceholder')}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                error={error ?? undefined}
                onSubmitEditing={() => void submit()}
                returnKeyType="send"
              />

              <Button
                label={t('auth.sendLink')}
                onPress={() => void submit()}
                loading={sending}
                disabled={!email.trim()}
                style={styles.action}
              />
            </>
          )}
        </AppScreen>
      </SinTecladoDelante>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xl },
  title: { marginTop: spacing.lg },
  subtitle: { marginTop: spacing.sm, marginBottom: spacing.xl },
  action: { marginTop: spacing.lg },
  done: { alignItems: 'center', gap: spacing.md, paddingTop: spacing.xxl },
  centered: { textAlign: 'center' },
  icon: {
    width: 68,
    height: 68,
    borderRadius: 34,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
});
