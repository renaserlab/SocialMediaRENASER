import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Feather } from '@expo/vector-icons';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { InlineError } from '@/components/InlineError';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { VideoPlayer } from '@/components/VideoPlayer';
import { toast } from '@/lib/toast';
import {
  ReviewRepository,
  mensajeDeErrorDeResena,
  type Resena,
} from '@/repositories/ReviewRepository';
import { pickImage, pickVideo, uploadPostMedia, type PickedMedia } from '@/services/storage';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Escribir una resena SOBRE otra persona.
 *
 * EN QUE SE DIFERENCIA DE `CreateTestimonialSheet`, que es lo que habia. Aquella
 * hoja publica en la galeria del propio perfil y EXIGE una foto o un video: su
 * boton esta desactivado hasta elegir archivo, porque `testimonials` tiene
 * `storage_path` NOT NULL. Aqui es al reves y es lo correcto para una resena:
 *
 *   * el TEXTO es obligatorio —es lo que aporta valor—,
 *   * la foto y el video son OPCIONALES,
 *   * y la resena va dirigida a alguien, asi que aparece en SU perfil.
 *
 * Las tres reglas las impone el servidor y ademas la RLS de la migracion 0030.
 * Lo de aqui solo evita que alguien escriba un texto para que se lo rechacen
 * despues.
 */

type Props = {
  visible: boolean;
  onClose: () => void;
  /** Sobre quien se opina. Es el dueno del perfil donde se esta. */
  sobreId: string;
  /** Su nombre, solo para poder decir a quien se esta reseñando. */
  sobreNombre?: string;
  /** Se llama tras publicar o editar, para recargar la lista. */
  onSaved?: () => void;
  /** Si llega, la hoja edita esa resena en vez de crear una nueva. */
  editando?: Resena | null;
};

export function CreateReviewSheet({
  visible,
  onClose,
  sobreId,
  sobreNombre,
  onSaved,
  editando,
}: Props) {
  const { colors } = useAppTheme();
  const editando_ = !!editando;
  const [texto, setTexto] = useState(editando?.texto ?? '');
  const [media, setMedia] = useState<PickedMedia | null>(null);
  /** Al editar, si se pulso la papelera sobre el archivo que ya tenia. */
  const [quitarMedio, setQuitarMedio] = useState(false);
  const [guardando, setGuardando] = useState(false);
  // El error se muestra DENTRO de la hoja: un dialogo encima de un Modal no se
  // ve en iOS. Ver `InlineError`.
  const [error, setError] = useState<string | null>(null);

  const medioActual = editando?.medios?.[0];

  const reiniciar = () => {
    setTexto(editando?.texto ?? '');
    setMedia(null);
    setQuitarMedio(false);
    setError(null);
  };

  const cerrar = () => {
    reiniciar();
    onClose();
  };

  const elegir = async (tipo: 'image' | 'video') => {
    try {
      const elegido = tipo === 'image' ? await pickImage() : await pickVideo();
      if (elegido) {
        setMedia(elegido);
        setQuitarMedio(false);
        setError(null);
      }
    } catch {
      setError('No se pudo abrir el selector. Revisa los permisos e inténtalo de nuevo.');
    }
  };

  const publicar = async () => {
    const limpio = texto.trim();
    if (!limpio) {
      // La unica exigencia. En la hoja anterior el bloqueo era «elige una foto»,
      // que es justo lo contrario de lo que pide una resena.
      setError('Escribe tu reseña: el texto es lo importante.');
      return;
    }
    setGuardando(true);
    setError(null);
    try {
      /*
        El archivo se sube ANTES de crear la resena, y directamente a Storage:
        asi el fichero no atraviesa la API. La ruta la construye
        `uploadPostMedia` bajo la carpeta del usuario (`<uid>/...`), que es lo
        que exige la politica del bucket; el servidor lo vuelve a comprobar.
      */
      const subido = media ? await uploadPostMedia(media) : null;

      /*
        Que se manda como `medios`:
          - hay archivo nuevo -> ese.
          - se pidio quitarlo -> lista vacia, que es como se borra.
          - ninguna de las dos -> `undefined`, y el servidor deja los que haya.
      */
      const medios = subido
        ? [{ storagePath: subido.storagePath, tipo: subido.mediaType as 'image' | 'video' }]
        : quitarMedio
        ? []
        : undefined;

      if (editando) {
        await ReviewRepository.editar(editando.id, { texto: limpio, medios });
      } else {
        await ReviewRepository.publicar(sobreId, { texto: limpio, medios });
      }
      toast(editando_ ? 'Reseña actualizada' : 'Reseña publicada');
      reiniciar();
      onSaved?.();
      onClose();
    } catch (fallo) {
      // El motivo REAL del servidor, traducido. Antes cualquier fallo salia
      // como «No se pudo publicar», y el caso mas frecuente —ya hay una resena
      // sobre esa persona— no se distinguia de un problema de red.
      setError(mensajeDeErrorDeResena(fallo));
    } finally {
      setGuardando(false);
    }
  };

  const mostrarMedioActual = !media && !quitarMedio && !!medioActual?.url;

  return (
    <BottomSheet visible={visible} onClose={cerrar}>
      <Text style={styles.title} color={colors.text}>
        {editando_ ? 'Editar tu reseña' : 'Escribir una reseña'}
      </Text>

      {sobreNombre ? (
        <Text variant="secondary" color={colors.textMuted} style={styles.about}>
          {`Sobre ${sobreNombre}. Aparecerá en su perfil con tu nombre.`}
        </Text>
      ) : null}

      <Input
        value={texto}
        onChangeText={setTexto}
        placeholder="Cuenta tu experiencia con esta persona"
        placeholderTextColor={colors.textMuted}
        maxLength={2000}
        multiline
        style={[styles.body, { color: colors.text }]}
      />

      {media ? (
        <View style={styles.previewWrap}>
          {media.kind === 'video' ? (
            <VideoPlayer uri={media.uri} style={styles.preview} nativeControls muted />
          ) : (
            <ExpoImage source={{ uri: media.uri }} style={styles.preview} contentFit="cover" />
          )}
          <Pressable
            onPress={() => setMedia(null)}
            style={[styles.removeBtn, { backgroundColor: colors.text }]}
            accessibilityRole="button"
            accessibilityLabel="Quitar archivo"
            hitSlop={8}
          >
            <Feather name="x" size={15} color={colors.background} />
          </Pressable>
        </View>
      ) : mostrarMedioActual ? (
        <View style={styles.previewWrap}>
          {medioActual?.tipo === 'video' ? (
            <VideoPlayer uri={medioActual.url!} style={styles.preview} nativeControls muted />
          ) : (
            <ExpoImage
              source={{ uri: medioActual!.url! }}
              style={styles.preview}
              contentFit="cover"
            />
          )}
          <Pressable
            onPress={() => setQuitarMedio(true)}
            style={[styles.removeBtn, { backgroundColor: colors.text }]}
            accessibilityRole="button"
            accessibilityLabel="Quitar el archivo actual"
            hitSlop={8}
          >
            <Feather name="trash-2" size={14} color={colors.background} />
          </Pressable>
        </View>
      ) : null}

      {/* Adjuntar es OPCIONAL y se dice: sin este texto, dos botones grandes
          hacen pensar que hay que elegir uno para poder publicar. */}
      <Text variant="secondary" color={colors.textMuted} style={styles.optional}>
        Puedes añadir una foto o un vídeo (opcional)
      </Text>
      <View style={styles.pickRow}>
        <Button
          label="Foto"
          icon="image"
          variant="secondary"
          onPress={() => void elegir('image')}
          style={styles.pickBtn}
        />
        <Button
          label="Vídeo"
          icon="video"
          variant="secondary"
          onPress={() => void elegir('video')}
          style={styles.pickBtn}
        />
      </View>

      <InlineError message={error} />

      <Button
        label={editando_ ? 'Guardar cambios' : 'Publicar reseña'}
        onPress={() => void publicar()}
        loading={guardando}
        // Solo el texto. El archivo NUNCA bloquea el boton: era el fallo de la
        // hoja anterior, donde sin foto no se podia publicar nada.
        disabled={!texto.trim()}
        style={styles.submit}
      />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  title: {
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.sm,
  },
  about: { marginBottom: spacing.md },
  body: { minHeight: 96, textAlignVertical: 'top' },
  optional: { marginTop: spacing.md, fontSize: 12 },
  pickRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  pickBtn: { flex: 1 },
  previewWrap: { position: 'relative', marginTop: spacing.md },
  preview: { width: '100%', height: 180, borderRadius: radius.lg, overflow: 'hidden' },
  removeBtn: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submit: { marginTop: spacing.lg },
});
