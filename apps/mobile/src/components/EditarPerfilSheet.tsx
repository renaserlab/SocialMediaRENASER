import React from 'react';
import { StyleSheet, View } from 'react-native';

import { AudioDePresentacion } from '@/components/AudioDePresentacion';
import { Avatar } from '@/components/Avatar';
import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { CamposDePerfil } from '@/components/CamposDePerfil';
import { ListRow } from '@/components/ListRow';
import { Text } from '@/components/Text';
import type { FormularioDePerfil } from '@/hooks/useFormularioDePerfil';
import { useTranslation } from '@/i18n/useTranslation';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  visible: boolean;
  onClose: () => void;
  /** Borrador y reglas. Vive en quien abre la bandeja (ver `useFormularioDePerfil`). */
  formulario: FormularioDePerfil;
  /** Lo mismo que se pinta en el perfil. */
  avatar: React.ComponentProps<typeof Avatar>['image'];
  tieneFotoPropia: boolean;
  /**
   * Elegir o hacer la foto. El selector del sistema se abre ENCIMA de la
   * bandeja abierta, que es lo que funciona en iOS (ver `applyPhoto` en el
   * perfil); la confirmacion del recorte llega despues, con la bandeja cerrada.
   */
  alElegirFoto: (origen: 'gallery' | 'camera') => void;
  alQuitarFoto: () => void;
  /** Un fallo con la foto, contado aqui dentro: encima de la hoja no se ve un aviso. */
  avisoDeFoto: string | null;
  audio: {
    ruta: string | null | undefined;
    duracionS: number | null | undefined;
    nombre: string;
  };
  /** Un fallo al guardar que no es de un campo concreto. */
  avisoAlGuardar: string | null;
  alGuardar: () => void;
};

/**
 * La bandeja «Editar perfil»: foto, nombre completo, nombre de usuario,
 * biografia y audio de presentacion.
 *
 * LO QUE CAMBIO (25/09/2026). El perfil propio tenia un boton «Editar perfil»
 * que llevaba a otra pantalla con solo tres campos, y la tarjeta de grabar la
 * presentacion ocupaba sitio en la propia ficha. Ahora un lapiz junto a la foto
 * abre esta bandeja con todo lo que es de la persona, y la ficha se queda con lo
 * que ven los demas.
 *
 * NADA DE DIALOGOS AQUI DENTRO. Es un `Modal`: en iOS no se presenta nada
 * encima, `confirm()` no resolveria y la pantalla se quedaria esperando. Los
 * fallos se cuentan en la propia bandeja y el audio confirma el borrado en su
 * tarjeta (`enHoja`).
 */
export function EditarPerfilSheet({
  visible,
  onClose,
  formulario,
  avatar,
  tieneFotoPropia,
  alElegirFoto,
  alQuitarFoto,
  avisoDeFoto,
  audio,
  avisoAlGuardar,
  alGuardar,
}: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text style={[styles.titulo, { color: colors.text }]}>{t('profile.editProfile')}</Text>

      {/* FOTO */}
      <View style={styles.foto}>
        <Avatar size={72} image={avatar} />
      </View>
      <ListRow
        title={t('profile.pickFromGallery')}
        leftIcon="image"
        onPress={() => alElegirFoto('gallery')}
      />
      <ListRow
        title={t('profile.takePhoto')}
        leftIcon="camera"
        onPress={() => alElegirFoto('camera')}
      />
      {tieneFotoPropia ? (
        <ListRow
          title={t('profile.removePhoto')}
          leftIcon="trash-2"
          destructive
          onPress={alQuitarFoto}
        />
      ) : null}
      {avisoDeFoto ? (
        <Text variant="caption" weight="700" color={colors.danger} style={styles.aviso}>
          {avisoDeFoto}
        </Text>
      ) : null}

      {/* NOMBRE, USUARIO Y BIOGRAFIA */}
      <View style={styles.campos}>
        <CamposDePerfil formulario={formulario} />
      </View>

      {/* AUDIO DE PRESENTACION: se graba y se guarda por su cuenta. */}
      <Text variant="caption" weight="700" color={colors.textMuted} style={styles.seccion}>
        {t('editProfile.introSection')}
      </Text>
      <AudioDePresentacion
        rutaDelAudio={audio.ruta}
        duracionS={audio.duracionS}
        esPropio
        nombre={audio.nombre}
        enHoja
      />

      {avisoAlGuardar ? (
        <Text variant="caption" weight="700" color={colors.danger} style={styles.aviso}>
          {avisoAlGuardar}
        </Text>
      ) : null}
      <Button
        label={t('common.saveChanges')}
        onPress={alGuardar}
        loading={formulario.saving}
        style={styles.guardar}
      />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  titulo: {
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.sm,
  },
  foto: { alignItems: 'center', marginBottom: spacing.xs },
  campos: { gap: spacing.md, marginTop: spacing.md },
  seccion: { marginTop: spacing.lg },
  aviso: { marginTop: spacing.sm },
  guardar: { marginTop: spacing.lg },
});
