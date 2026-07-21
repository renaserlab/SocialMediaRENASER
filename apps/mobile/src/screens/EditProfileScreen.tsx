import React, { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

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

export function EditProfileScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const keyboardOffset = useKeyboardOffset();
  const user = useAppStore((state) => state.user);
  const updateProfile = useAuthStore((state) => state.updateProfile);

  const [fullName, setFullName] = useState(user?.fullName ?? '');
  const [username, setUsername] = useState((user?.username ?? '').replace(/^@/, ''));
  const [bio, setBio] = useState(user?.bio ?? '');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<{ fullName?: string; username?: string }>({});

  const save = async () => {
    const newErrors: { fullName?: string; username?: string } = {};
    if (fullName.trim().length < 3) {
      newErrors.fullName = 'El nombre debe tener al menos 3 caracteres';
    }
    if (username && !/^[a-zA-Z0-9_.-]{3,50}$/.test(username.trim())) {
      newErrors.username = 'Usuario inválido (3-50, letras/números/._-)';
    }
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setSaving(true);
    try {
      await updateProfile({
        fullName: fullName.trim(),
        username: username.trim(),
        bio: bio.trim(),
      });
      (router.canGoBack() ? router.back() : router.replace('/'));
    } catch (error) {
      const message =
        error instanceof ApiError || error instanceof Error
          ? error.message
          : 'No se pudieron guardar los cambios.';
      if (error instanceof ApiError && error.status === 409) {
        setErrors({ username: 'Ese nombre de usuario ya está en uso' });
      } else {
        Alert.alert('No se pudo guardar', message);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="Editar perfil" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.select({ ios: 'padding', android: 'height' })}
        keyboardVerticalOffset={keyboardOffset}
      >
      <AppScreen contentStyle={{ paddingBottom: spacing.xl }}>
        <View style={styles.container}>
          <Input
            label="Nombre completo"
            value={fullName}
            onChangeText={(t) => {
              setFullName(t);
              setErrors((e) => ({ ...e, fullName: undefined }));
            }}
            placeholder="Tu nombre"
            error={errors.fullName}
          />

          <Input
            label="Nombre de usuario"
            value={username}
            onChangeText={(t) => {
              setUsername(t);
              setErrors((e) => ({ ...e, username: undefined }));
            }}
            placeholder="tu_usuario"
            autoCapitalize="none"
            error={errors.username}
          />

          <Input
            label="Biografía"
            value={bio}
            onChangeText={setBio}
            placeholder="Cuéntale a la comunidad sobre ti"
            multiline
            numberOfLines={4}
            style={styles.bioInput}
          />

          <Button label="Guardar cambios" onPress={save} loading={saving} style={{ marginTop: spacing.sm }} />
        </View>
      </AppScreen>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing.xl, gap: spacing.md, paddingTop: spacing.lg },
  bioInput: { minHeight: 96, textAlignVertical: 'top' },
});
