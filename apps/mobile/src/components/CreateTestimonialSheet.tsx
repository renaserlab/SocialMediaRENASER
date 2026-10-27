import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import Feather from '@expo/vector-icons/Feather';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { InlineError } from '@/components/InlineError';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { VideoPlayer } from '@/components/VideoPlayer';
import { toast } from '@/lib/toast';
import { TestimonialRepository } from '@/repositories/TestimonialRepository';
import { pickImage, pickVideo, uploadPostMedia, type PickedMedia } from '@/services/storage';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

/** Testimonio existente cuando la hoja se usa para editar. */
export type TestimonialEditable = {
  id: string;
  caption: string;
  mediaType: 'image' | 'video';
  /** URL firmada del medio actual, para la vista previa. */
  mediaUrl?: string;
};

type Props = {
  visible: boolean;
  onClose: () => void;
  /** Se llama tras publicar o editar, para recargar la galeria. */
  onCreated?: () => void;
  /** Si llega, la hoja edita ese testimonio en vez de crear uno nuevo. */
  editing?: TestimonialEditable | null;
};

/**
 * Alta en la GALERIA de un perfil: titulo + una foto o un video.
 *
 * ESTO NO ES UNA RESEÑA, aunque durante un tiempo se llamara asi. `testimonials`
 * guarda las fotos y videos que publica UNA persona: el archivo es obligatorio
 * (`storage_path` NOT NULL, por eso el boton de abajo exige elegir uno) y no hay
 * ninguna columna que diga sobre QUIEN se opina. Con esa forma, lo que alguien
 * escribia salia en su PROPIO perfil.
 *
 * Para opinar sobre otra persona esta `CreateReviewSheet`, que escribe en
 * `profile_reviews` (migracion 0030): ahi el texto es lo obligatorio, el archivo
 * es opcional y la resena aparece en el perfil de quien la recibe.
 *
 * Quien puede publicar aqui lo decide la RLS de `testimonials`: desde la
 * migracion 0017, cualquiera en su propio nombre (`author_id = auth.uid()`).
 * La comprobacion de la interfaz solo evita ensenar botones inutiles.
 */
export function CreateTestimonialSheet({ visible, onClose, onCreated, editing }: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const isEditing = !!editing;
  const [title, setTitle] = useState(editing?.caption ?? '');
  const [media, setMedia] = useState<PickedMedia | null>(null);
  const [saving, setSaving] = useState(false);
  // El error se muestra dentro de la hoja: un dialogo encima de un Modal no se
  // ve en iOS. Ver `InlineError`.
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTitle(editing?.caption ?? '');
    setMedia(null);
    setError(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const choose = async (kind: 'image' | 'video') => {
    try {
      const picked = kind === 'image' ? await pickImage() : await pickVideo();
      if (picked) {
        setMedia(picked);
        setError(null);
      }
    } catch {
      setError(t('resources.pickerFailed'));
    }
  };

  const publish = async () => {
    if (!title.trim()) {
      setError(t('testimonial.needTitle'));
      return;
    }
    // Al editar, el archivo es opcional: sin uno nuevo se conserva el actual.
    if (!isEditing && !media) {
      setError(t('testimonial.needMedia'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const uploaded = media ? await uploadPostMedia(media) : null;
      if (editing) {
        await TestimonialRepository.update(editing.id, {
          caption: title.trim(),
          media: uploaded,
        });
      } else {
        await TestimonialRepository.create(uploaded!, title.trim());
      }
      toast(isEditing ? t('common.changesSaved') : t('testimonial.published'));
      reset();
      onCreated?.();
      onClose();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : isEditing
          ? 'No se pudo guardar. Inténtalo de nuevo.'
          : 'No se pudo publicar. Inténtalo de nuevo.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet visible={visible} onClose={close}>
      <Text style={styles.title} color={colors.text}>
        {isEditing ? t('review.edit') : t('testimonial.newTitle')}
      </Text>

      <Input
        value={title}
        onChangeText={setTitle}
        placeholder={t('testimonial.titlePlaceholder')}
        placeholderTextColor={colors.textMuted}
        maxLength={300}
        style={{ color: colors.text }}
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
            accessibilityLabel={t('testimonial.removeFile')}
            hitSlop={8}
          >
            <Feather name="x" size={15} color={colors.background} />
          </Pressable>
        </View>
      ) : (
        <View>
          {/* Al editar se muestra el archivo actual; cambiarlo es opcional. */}
          {isEditing && editing?.mediaUrl ? (
            <View style={styles.previewWrap}>
              {editing.mediaType === 'video' ? (
                <VideoPlayer uri={editing.mediaUrl} style={styles.preview} nativeControls muted />
              ) : (
                <ExpoImage
                  source={{ uri: editing.mediaUrl }}
                  style={styles.preview}
                  contentFit="cover"
                />
              )}
            </View>
          ) : null}

          <View style={styles.pickRow}>
            <Button
              label={isEditing ? t('editPost.swapImage') : t('gallery.photo')}
              icon="image"
              variant="secondary"
              onPress={() => void choose('image')}
              style={styles.pickBtn}
            />
            <Button
              label={isEditing ? t('editPost.swapVideo') : t('video.video')}
              icon="video"
              variant="secondary"
              onPress={() => void choose('video')}
              style={styles.pickBtn}
            />
          </View>
        </View>
      )}

      <InlineError message={error} />

      <Button
        label={isEditing ? t('common.saveChanges') : t('common.publish')}
        onPress={() => void publish()}
        loading={saving}
        disabled={!title.trim() || (!isEditing && !media)}
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
    marginBottom: spacing.md,
  },
  pickRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
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
