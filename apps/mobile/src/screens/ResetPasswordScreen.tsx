import React, { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { useKeyboardOffset } from '@/hooks/useKeyboardOffset';
import { mensajeDeAuth } from '@/lib/authErrors';
import { postAuthRoute } from '@/lib/postAuthRoute';
import { toast } from '@/lib/toast';
import { useAuthStore } from '@/store/useAuthStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/** Longitud mínima; la misma que exige el registro. */
const MIN_LENGTH = 6;

/**
 * Fija la contraseña nueva tras pulsar el enlace del correo.
 *
 * No pide la contraseña anterior: quien llega aquí lo hace con la sesión de
 * recuperación que abre Supabase al validar el enlace, y esa sesión es la
 * autorización.
 */
export function ResetPasswordScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const keyboardOffset = useKeyboardOffset();

  const updatePassword = useAuthStore((state) => state.updatePassword);
  const status = useAuthStore((state) => state.status);
  const passwordRecovery = useAuthStore((state) => state.passwordRecovery);
  const recoveryError = useAuthStore((state) => state.recoveryError);
  const setRecoveryError = useAuthStore((state) => state.setRecoveryError);

  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Mismo cerrojo que en el envio del correo: `saving` es estado de React y no
  // frena dos pulsaciones simultaneas. Guardar dos veces la contrasena hacia
  // que la segunda llamada fallara y tapara el exito de la primera.
  const guardando = useRef(false);

  const submit = async () => {
    if (guardando.current) return;
    if (password.length < MIN_LENGTH) {
      setError(`La contraseña debe tener al menos ${MIN_LENGTH} caracteres.`);
      return;
    }
    if (password !== repeat) {
      setError('Las dos contraseñas no coinciden.');
      return;
    }
    guardando.current = true;
    setSaving(true);
    setError(null);
    try {
      await updatePassword(password);
      toast('Contraseña actualizada');
      router.replace(postAuthRoute() as never);
    } catch (err) {
      // Mismo criterio que en el envio del correo: el motivo tecnico va a la
      // consola y a la pantalla solo sale algo que se pueda entender y usar.
      setError(mensajeDeAuth(err, 'nueva-contrasena'));
    } finally {
      guardando.current = false;
      setSaving(false);
    }
  };

  // Sin sesión de recuperación no hay nada que cambiar: el enlace caducó, ya se
  // usó, o se entró a la ruta a mano. `recoveryError` manda sobre la sesión:
  // un enlace rechazado no debe dejar cambiar la contraseña aunque quedara una
  // sesión anterior abierta en el mismo teléfono.
  if (recoveryError || (status !== 'authenticated' && !passwordRecovery)) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="" onBack={() => router.replace('/login')} />
        <StateView
          state="empty"
          icon="alert-triangle"
          title="Enlace no válido o caducado"
          /*
            Se prefiere el motivo concreto cuando se conoce (caducado, ya
            usado): decirle a alguien «no es válido» sin mas le deja sin saber
            si el problema es suyo, del correo o de la aplicación.
          */
          description={
            recoveryError ??
            'Vuelve a pedir el correo de recuperación para crear tu contraseña.'
          }
        />
        <View style={styles.footer}>
          <Button
            label="Pedir un enlace nuevo"
            onPress={() => {
              // Se limpia el motivo al salir: si no, el aviso del enlace viejo
              // seguiría puesto al volver de pedir uno nuevo.
              setRecoveryError(null);
              router.replace('/forgot-password');
            }}
          />
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="" />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.select({ ios: 'padding', android: 'height' })}
        keyboardVerticalOffset={keyboardOffset}
      >
        <AppScreen contentStyle={styles.screen}>
          <Text variant="title" weight="900" style={styles.title}>
            Crea tu contraseña nueva
          </Text>
          <Text variant="body" color={colors.textMuted} style={styles.subtitle}>
            Se cerrará esta pantalla en cuanto la guardes.
          </Text>

          <Input
            label="Contraseña nueva"
            value={password}
            onChangeText={(t) => {
              setPassword(t);
              setError(null);
            }}
            placeholder={`Mínimo ${MIN_LENGTH} caracteres`}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="new-password"
          />
          <Input
            label="Repite la contraseña"
            value={repeat}
            onChangeText={(t) => {
              setRepeat(t);
              setError(null);
            }}
            placeholder="Vuelve a escribirla"
            secureTextEntry
            autoCapitalize="none"
            autoComplete="new-password"
            error={error ?? undefined}
            onSubmitEditing={() => void submit()}
            returnKeyType="done"
          />

          <Button
            label="Guardar contraseña"
            onPress={() => void submit()}
            loading={saving}
            disabled={!password || !repeat}
            style={styles.action}
          />
        </AppScreen>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xl, gap: spacing.md },
  title: { marginTop: spacing.lg },
  subtitle: { marginTop: spacing.sm, marginBottom: spacing.md },
  action: { marginTop: spacing.lg },
  footer: { padding: spacing.xl },
});
