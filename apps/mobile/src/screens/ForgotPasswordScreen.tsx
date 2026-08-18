import React, { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { useKeyboardOffset } from '@/hooks/useKeyboardOffset';
import { mensajeDeAuth } from '@/lib/authErrors';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/** Pide el correo y envía el enlace para restablecer la contraseña. */
export function ForgotPasswordScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const keyboardOffset = useKeyboardOffset();
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
      setError('Escribe un correo válido.');
      return;
    }
    if (!supabaseEnabled) {
      setError('La recuperación necesita conexión con el servidor.');
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
      setError(mensajeDeAuth(err, 'recuperacion'));
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
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.select({ ios: 'padding', android: 'height' })}
        keyboardVerticalOffset={keyboardOffset}
      >
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
                Revisa tu correo
              </Text>
              <Text variant="body" color={colors.textMuted} style={styles.centered}>
                Si <Text weight="700">{email.trim().toLowerCase()}</Text> tiene una cuenta, le
                enviamos un enlace para crear una contraseña nueva. Caduca en una hora.
              </Text>
              <Text variant="secondary" color={colors.textMuted} style={styles.centered}>
                ¿No lo ves? Mira en spam o correo no deseado.
              </Text>
              <Button
                label="Volver a iniciar sesión"
                onPress={() => router.replace('/login')}
                style={styles.action}
              />
              <Button
                label="Enviar a otro correo"
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
                ¿Olvidaste tu contraseña?
              </Text>
              <Text variant="body" color={colors.textMuted} style={styles.subtitle}>
                Escribe tu correo y te enviamos un enlace para crear una nueva.
              </Text>

              <Input
                label="Correo electrónico"
                value={email}
                onChangeText={(t) => {
                  setEmail(t);
                  setError(null);
                }}
                placeholder="ejemplo@correo.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                error={error ?? undefined}
                onSubmitEditing={() => void submit()}
                returnKeyType="send"
              />

              <Button
                label="Enviar enlace"
                onPress={() => void submit()}
                loading={sending}
                disabled={!email.trim()}
                style={styles.action}
              />
            </>
          )}
        </AppScreen>
      </KeyboardAvoidingView>
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
