import React from 'react';
import { StyleSheet } from 'react-native';

import { Input } from '@/components/Input';
import type { FormularioDePerfil } from '@/hooks/useFormularioDePerfil';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * Nombre completo, nombre de usuario y biografia.
 *
 * Los mismos tres campos en la bandeja del perfil y en `/edit-profile`: el
 * estado y las reglas vienen de `useFormularioDePerfil`, aqui solo se pintan.
 */
export function CamposDePerfil({ formulario }: { formulario: FormularioDePerfil }) {
  const { t } = useTranslation();
  return (
    <React.Fragment>
      <Input
        label={t('auth.fullName')}
        value={formulario.fullName}
        onChangeText={formulario.cambiarNombre}
        placeholder={t('editProfile.namePlaceholder')}
        error={formulario.errors.fullName}
      />

      <Input
        label={t('editProfile.username')}
        value={formulario.username}
        onChangeText={formulario.cambiarUsuario}
        placeholder="tu_usuario"
        autoCapitalize="none"
        error={formulario.errors.username}
      />

      <Input
        label={t('editProfile.bio')}
        value={formulario.bio}
        onChangeText={formulario.setBio}
        placeholder={t('editProfile.bioPlaceholder')}
        multiline
        numberOfLines={4}
        style={styles.bioInput}
      />
    </React.Fragment>
  );
}

const styles = StyleSheet.create({
  bioInput: { minHeight: 96, textAlignVertical: 'top' },
});
