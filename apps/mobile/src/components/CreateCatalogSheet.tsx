import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Feather } from '@expo/vector-icons';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import { CatalogRepository } from '@/repositories/CatalogRepository';
import { LearningRepository } from '@/repositories/LearningRepository';
import { pickImage, uploadPostMedia, type PickedMedia } from '@/services/storage';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export type CatalogKind = 'evento' | 'curso';

type Props = {
  kind: CatalogKind;
  visible: boolean;
  onClose: () => void;
  /** Se llama tras crear, para que la pantalla recargue su listado. */
  onCreated?: () => void;
};

/** dd/mm/aaaa + hh:mm -> Date. Devuelve null si la combinacion no es valida. */
function parseDateTime(day: string, time: string): Date | null {
  const d = day.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const t = time.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!d || !t) return null;
  const [, dd, mm, yyyy] = d;
  const [, hh, min] = t;
  const date = new Date(
    Number(yyyy),
    Number(mm) - 1,
    Number(dd),
    Number(hh),
    Number(min),
  );
  // Rechaza fechas imposibles (31/02) que Date normalizaria en silencio.
  if (
    date.getFullYear() !== Number(yyyy) ||
    date.getMonth() !== Number(mm) - 1 ||
    date.getDate() !== Number(dd) ||
    Number(hh) > 23 ||
    Number(min) > 59
  ) {
    return null;
  }
  return date;
}

/**
 * Alta de evento o curso, para el administrador.
 *
 * El permiso real lo aplica el backend (`require_admin` contra
 * `profiles.role`). Esta hoja solo se muestra a quien puede usarla.
 */
export function CreateCatalogSheet({ kind, visible, onClose, onCreated }: Props) {
  const { colors } = useAppTheme();
  const isEvent = kind === 'evento';

  const [cover, setCover] = useState<PickedMedia | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [day, setDay] = useState('');
  const [time, setTime] = useState('');
  const [place, setPlace] = useState('');
  const [price, setPrice] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setCover(null);
    setTitle('');
    setDescription('');
    setDay('');
    setTime('');
    setPlace('');
    setPrice('');
    setError(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const chooseCover = async () => {
    try {
      // 16:9 es la proporcion de un banner de portada.
      const picked = await pickImage([16, 9]);
      if (picked) setCover(picked);
    } catch {
      setError('No se pudo abrir la galería.');
    }
  };

  const submit = async () => {
    if (!title.trim()) {
      setError(`Escribe el nombre del ${kind}.`);
      return;
    }
    let startsAt: Date | null = null;
    if (isEvent) {
      startsAt = parseDateTime(day, time);
      if (!startsAt) {
        setError('Revisa el día (dd/mm/aaaa) y la hora (hh:mm).');
        return;
      }
    }

    setSaving(true);
    setError(null);
    try {
      // La portada se sube primero: se guarda su RUTA, no una URL.
      const coverPath = cover ? (await uploadPostMedia(cover)).storagePath : null;

      if (isEvent) {
        await CatalogRepository.createEvent({
          title: title.trim(),
          description: description.trim(),
          startsAt: startsAt!,
          location: place.trim(),
          coverPath,
        });
      } else {
        await LearningRepository.createCourse({
          title: title.trim(),
          description: description.trim(),
          price: Number(price) || 0,
          currency: 'PEN',
          coverPath,
        });
      }
      notify(
        isEvent ? 'Evento publicado' : 'Curso publicado',
        'Ya está disponible para la comunidad.',
      );
      onCreated?.();
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo publicar.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet visible={visible} onClose={close}>
      <Text style={styles.sheetTitle} color={colors.text}>
        {isEvent ? 'Nuevo evento' : 'Nuevo curso'}
      </Text>

      <ScrollView keyboardShouldPersistTaps="handled" style={styles.scroll}>
        <Pressable
          onPress={chooseCover}
          style={[styles.cover, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}
          accessibilityRole="button"
          accessibilityLabel="Elegir portada"
        >
          {cover ? (
            <ExpoImage source={{ uri: cover.uri }} style={StyleSheet.absoluteFill} contentFit="cover" />
          ) : (
            <View style={styles.coverEmpty}>
              <Feather name="image" size={22} color={colors.textMuted} />
              <Text variant="secondary" color={colors.textMuted}>
                Portada ({isEvent ? 'foto o banner' : 'imagen del curso'})
              </Text>
            </View>
          )}
        </Pressable>

        <Input
          label={isEvent ? 'Nombre del evento' : 'Nombre del curso'}
          value={title}
          onChangeText={setTitle}
          placeholder={isEvent ? 'Encuentro RENASER' : 'Liderazgo consciente'}
        />
        <Input
          label="Descripción"
          value={description}
          onChangeText={setDescription}
          placeholder="De qué trata"
          multiline
        />

        {isEvent ? (
          <>
            <Input label="Día" value={day} onChangeText={setDay} placeholder="dd/mm/aaaa" />
            <Input label="Hora" value={time} onChangeText={setTime} placeholder="hh:mm" />
            <Input label="Lugar" value={place} onChangeText={setPlace} placeholder="Dirección o enlace" />
          </>
        ) : (
          <Input
            label="Precio (PEN)"
            value={price}
            onChangeText={setPrice}
            placeholder="0"
            keyboardType="numeric"
          />
        )}

        {error ? (
          <Text variant="secondary" color={colors.danger} style={styles.error}>
            {error}
          </Text>
        ) : null}

        <Button
          label={isEvent ? 'Publicar evento' : 'Publicar curso'}
          onPress={() => void submit()}
          loading={saving}
          style={styles.submit}
        />
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  sheetTitle: {
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.md,
  },
  scroll: { maxHeight: 460 },
  cover: {
    height: 140,
    borderWidth: 1,
    borderRadius: radius.lg,
    overflow: 'hidden',
    marginBottom: spacing.md,
  },
  coverEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.xs },
  error: { marginTop: spacing.sm },
  submit: { marginTop: spacing.lg, marginBottom: spacing.lg },
});
