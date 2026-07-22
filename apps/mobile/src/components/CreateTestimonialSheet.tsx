import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Feather } from '@expo/vector-icons';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { VideoPlayer } from '@/components/VideoPlayer';
import { notify } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import { TestimonialRepository } from '@/repositories/TestimonialRepository';
import { pickImage, pickVideo, uploadPostMedia, type PickedMedia } from '@/services/storage';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

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
 * Alta de un testimonio: titulo + una foto o un video.
 *
 * Solo la abre el administrador, pero quien decide de verdad es la RLS de
 * `testimonials`, que exige `public.is_admin()` para insertar.
 */
export function CreateTestimonialSheet({ visible, onClose, onCreated, editing }: Props) {
  const { colors } = useAppTheme();
  const isEditing = !!editing;
  const [title, setTitle] = useState(editing?.caption ?? '');
  const [media, setMedia] = useState<PickedMedia | null>(null);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setTitle(editing?.caption ?? '');
    setMedia(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const choose = async (kind: 'image' | 'video') => {
    try {
      const picked = kind === 'image' ? await pickImage() : await pickVideo();
      if (picked) setMedia(picked);
    } catch {
      notify('No se pudo abrir el selector', 'Revisa los permisos e inténtalo de nuevo.');
    }
  };

  const publish = async () => {
    if (!title.trim()) {
      notify('Falta el título', 'Escribe un título para el testimonio.');
      return;
    }
    // Al editar, el archivo es opcional: sin uno nuevo se conserva el actual.
    if (!isEditing && !media) {
      notify('Falta el archivo', 'Elige una foto o un video.');
      return;
    }
    setSaving(true);
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
      toast(isEditing ? 'Cambios guardados' : 'Testimonio publicado');
      reset();
      onCreated?.();
      onClose();
    } catch (error) {
      notify(
        isEditing ? 'No se pudo guardar' : 'No se pudo publicar',
        error instanceof Error ? error.message : 'Inténtalo de nuevo.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet visible={visible} onClose={close}>
      <Text style={styles.title} color={colors.text}>
        {isEditing ? 'Editar testimonio' : 'Nuevo testimonio'}
      </Text>

      <Input
        value={title}
        onChangeText={setTitle}
        placeholder="Título del testimonio"
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
            accessibilityLabel="Quitar archivo"
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
              label={isEditing ? 'Cambiar por foto' : 'Foto'}
              icon="image"
              variant="secondary"
              onPress={() => void choose('image')}
              style={styles.pickBtn}
            />
            <Button
              label={isEditing ? 'Cambiar por video' : 'Video'}
              icon="video"
              variant="secondary"
              onPress={() => void choose('video')}
              style={styles.pickBtn}
            />
          </View>
        </View>
      )}

      <Button
        label={isEditing ? 'Guardar cambios' : 'Publicar'}
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
