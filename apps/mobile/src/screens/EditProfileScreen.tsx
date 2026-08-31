import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { notify } from '@/lib/confirm';
import { useRouter } from 'expo-router';

import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { ApiError } from '@/services/api';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

export function EditProfileScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
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
      newErrors.fullName = t('auth.errorName');
    }
    if (username && !/^[a-zA-Z0-9_.-]{3,50}$/.test(username.trim())) {
      newErrors.username = t('editProfile.invalidUsername');
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
          : t('editProfile.saveFailedBody');
      if (error instanceof ApiError && error.status === 409) {
        setErrors({ username: t('editProfile.usernameTaken') });
      } else {
        notify(t('common.saveFailed'), message);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title={t('profile.editProfile')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />
      <SinTecladoDelante>
      <AppScreen contentStyle={{ paddingBottom: spacing.xl }}>
        <View style={styles.container}>
          <Input
            label={t('auth.fullName')}
            value={fullName}
            onChangeText={(t) => {
              setFullName(t);
              setErrors((e) => ({ ...e, fullName: undefined }));
            }}
            placeholder={t('editProfile.namePlaceholder')}
            error={errors.fullName}
          />

          <Input
            label={t('editProfile.username')}
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
            label={t('editProfile.bio')}
            value={bio}
            onChangeText={setBio}
            placeholder={t('editProfile.bioPlaceholder')}
            multiline
            numberOfLines={4}
            style={styles.bioInput}
          />

          <Button
            label={t('common.saveChanges')}
            onPress={save}
            loading={saving}
            style={{ marginTop: spacing.sm }}
          />
        </View>
      </AppScreen>
      </SinTecladoDelante>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing.xl, gap: spacing.md, paddingTop: spacing.lg },
  bioInput: { minHeight: 96, textAlignVertical: 'top' },
});
