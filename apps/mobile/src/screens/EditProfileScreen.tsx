import React from 'react';
import { StyleSheet, View } from 'react-native';
import { notify } from '@/lib/confirm';
import { useRouter } from 'expo-router';

import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { CamposDePerfil } from '@/components/CamposDePerfil';
import { useFormularioDePerfil } from '@/hooks/useFormularioDePerfil';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * Editar el perfil como pantalla.
 *
 * Desde el 25/09/2026 lo normal es la BANDEJA que abre el lapiz del perfil
 * (`EditarPerfilSheet`), que ademas lleva la foto y el audio de presentacion.
 * Esta ruta se conserva porque puede haber enlaces a ella; comparte con la
 * bandeja los campos y las reglas (`useFormularioDePerfil`).
 */
export function EditProfileScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const formulario = useFormularioDePerfil();

  const save = async () => {
    const resultado = await formulario.guardar();
    if (resultado.ok) {
      (router.canGoBack() ? router.back() : router.replace('/'));
    } else if (resultado.motivo === 'servidor') {
      notify(t('common.saveFailed'), resultado.mensaje);
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
          <CamposDePerfil formulario={formulario} />

          <Button
            label={t('common.saveChanges')}
            onPress={save}
            loading={formulario.saving}
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
});
