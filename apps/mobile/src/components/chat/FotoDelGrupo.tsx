import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { Avatar } from '@/components/Avatar';
import { BottomSheet } from '@/components/BottomSheet';
import { ListRow } from '@/components/ListRow';
import { Text } from '@/components/Text';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { claveDelFalloDeGrupo, type InfoDeConversacion } from '@/lib/gruposDeChat';
import { GroupRepository } from '@/repositories/GroupRepository';
import { ApiError } from '@/services/api';
import {
  PermisoDenegadoError,
  describeStorageError,
  pickImage,
  profileImageUrl,
  takePhoto,
  uploadProfileImage,
} from '@/services/storage';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

const TAMANO = 72;
const INSIGNIA = 28;

type Props = {
  info: InfoDeConversacion;
  /** Se llama tras cada cambio, para que la ficha vuelva a leer el grupo. */
  alCambiar: () => void;
  /** El motivo de un fallo, ya escrito para leerse; `null` al volver a intentarlo. */
  alFallar: (mensaje: string | null) => void;
};

/**
 * La foto del grupo en lo alto de su ficha. PARA QUIEN ADMINISTRA ES TAMBIÉN
 * EL BOTÓN DE CAMBIARLA: se toca la foto y se elige de la galería, se toma con
 * la cámara o se quita, que es donde se busca en cualquier mensajería.
 *
 * NUNCA UN BOTÓN MUERTO. Solo se puede tocar si quien mira administra el grupo
 * y el servidor conoce la foto de grupo (`info.hayExtras`); si no, es la foto
 * y nada más. Es comodidad: el permiso lo vuelve a comprobar el servidor.
 */
export function FotoDelGrupo({ info, alCambiar, alFallar }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [abierta, setAbierta] = useState(false);
  const [ocupado, setOcupado] = useState(false);

  const grupoId = info.id;

  const motivo = useCallback(
    (error: unknown): string => {
      // Sin permiso para las fotos o la cámara: el texto ya dice dónde darlo.
      if (error instanceof PermisoDenegadoError) return error.message;
      if (error instanceof ApiError) return t(claveDelFalloDeGrupo(error.code) as TranslationKey);
      return describeStorageError(error);
    },
    [t],
  );

  const elegir = useCallback(
    async (origen: 'galeria' | 'camara') => {
      if (ocupado) return;
      alFallar(null);
      try {
        // La hoja se queda ABIERTA mientras se elige y se cierra después: en
        // iOS no se puede presentar el selector mientras un Modal se está
        // cerrando, y falla en silencio (ver `applyPhoto` en `ProfileScreen`).
        const elegida =
          origen === 'galeria'
            ? await pickImage({ aspect: [1, 1] })
            : await takePhoto({ aspect: [1, 1] });
        setAbierta(false);
        if (!elegida) return;
        setOcupado(true);
        // La foto se sube a la carpeta de imágenes de quien administra: es
        // donde el almacenamiento le deja escribir, y lo que exige el servidor.
        const ruta = await uploadProfileImage('avatar', elegida);
        await GroupRepository.ponerFoto(grupoId, ruta);
        alCambiar();
      } catch (error) {
        setAbierta(false);
        alFallar(motivo(error));
      } finally {
        setOcupado(false);
      }
    },
    [ocupado, alFallar, alCambiar, grupoId, motivo],
  );

  const quitar = useCallback(async () => {
    if (ocupado) return;
    setAbierta(false);
    alFallar(null);
    setOcupado(true);
    try {
      await GroupRepository.quitarFoto(grupoId);
      alCambiar();
    } catch (error) {
      alFallar(motivo(error));
    } finally {
      setOcupado(false);
    }
  }, [ocupado, alFallar, alCambiar, grupoId, motivo]);

  const foto = (
    <Avatar size={TAMANO} image={profileImageUrl(info.avatarPath) ?? null} name={info.titulo} />
  );

  if (!info.puedoAdministrar || !info.hayExtras) return foto;

  return (
    <>
      <Pressable
        onPress={() => setAbierta(true)}
        disabled={ocupado}
        accessibilityRole="button"
        accessibilityLabel={t(info.avatarPath ? 'groups.photoChange' : 'groups.photoAdd')}
        accessibilityState={{ busy: ocupado }}
        style={styles.toque}
      >
        {foto}
        <View
          style={[
            styles.insignia,
            { backgroundColor: colors.primary, borderColor: colors.background },
          ]}
        >
          {ocupado ? (
            <ActivityIndicator size="small" color={colors.onPrimary} />
          ) : (
            <Feather name="camera" size={14} color={colors.onPrimary} />
          )}
        </View>
      </Pressable>

      <BottomSheet visible={abierta} onClose={() => setAbierta(false)}>
        <Text weight="800" style={styles.titulo}>
          {t('groups.photoTitle')}
        </Text>
        <ListRow
          title={t('profile.pickFromGallery')}
          leftIcon="image"
          onPress={() => void elegir('galeria')}
        />
        <ListRow
          title={t('profile.takePhoto')}
          leftIcon="camera"
          onPress={() => void elegir('camara')}
        />
        {info.avatarPath ? (
          <ListRow
            title={t('groups.photoRemove')}
            leftIcon="trash-2"
            destructive
            onPress={() => void quitar()}
          />
        ) : null}
      </BottomSheet>
    </>
  );
}

const styles = StyleSheet.create({
  toque: { width: TAMANO, height: TAMANO },
  insignia: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: INSIGNIA,
    height: INSIGNIA,
    borderRadius: INSIGNIA / 2,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titulo: { fontSize: 17, marginBottom: spacing.sm },
});
