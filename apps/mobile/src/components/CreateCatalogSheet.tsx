import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Feather } from '@expo/vector-icons';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { DateField } from '@/components/DateField';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { CATEGORIES, PRIVATE_AUDIO_CATEGORY, type CategoryId } from '@/data/categories';
import { confirm, notify } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import { CourseContentRepository } from '@/repositories/CourseContentRepository';
import { CatalogRepository } from '@/repositories/CatalogRepository';
import { LearningRepository } from '@/repositories/LearningRepository';
import { pickAudio, pickImage, uploadPostMedia, type PickedMedia } from '@/services/storage';
import { PostRepository } from '@/repositories/PostRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export type CatalogKind = 'evento' | 'curso' | 'podcast' | 'privado';

/** Elemento existente cuando la hoja se usa para editar. */
export type CatalogEditable = {
  id: string;
  title: string;
  description: string;
  /** Solo eventos. */
  startsAt?: Date | null;
  endsAt?: Date | null;
  location?: string;
  whatsappUrl?: string;
  /** Solo cursos, en la unidad mayor. */
  price?: number;
};

type Props = {
  kind: CatalogKind;
  visible: boolean;
  onClose: () => void;
  /** Se llama tras crear o editar, para recargar el listado. */
  onCreated?: () => void;
  /** Si llega, la hoja edita ese elemento en vez de crear uno nuevo. */
  editing?: CatalogEditable | null;
  /** Al eliminar (solo cursos): la pantalla decide si volver atras. */
  onDeleted?: () => void;
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
export function CreateCatalogSheet({ kind, visible, onClose, onCreated, editing, onDeleted }: Props) {
  const { colors } = useAppTheme();
  const isEvent = kind === 'evento';
  /** El audio privado usa el mismo formulario que un episodio. */
  const isPrivate = kind === 'privado';
  const isPodcast = kind === 'podcast' || isPrivate;

  const [cover, setCover] = useState<PickedMedia | null>(null);
  /** Solo para podcast: el archivo de audio del episodio. */
  const [audio, setAudio] = useState<PickedMedia | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [day, setDay] = useState('');
  const [time, setTime] = useState('');
  const [place, setPlace] = useState('');
  /** Fin opcional del evento, para rangos de varios dias. */
  const [endDay, setEndDay] = useState('');
  const [endTime, setEndTime] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [price, setPrice] = useState('');
  /** Solo podcast: categoria del episodio, para los filtros. */
  const [category, setCategory] = useState<CategoryId | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Al abrir en modo edicion se precargan los valores actuales.
  useEffect(() => {
    if (!visible) return;
    if (!editing) {
      reset();
      return;
    }
    setTitle(editing.title);
    setDescription(editing.description);
    setPrice(editing.price != null ? String(editing.price) : '');
    setPlace(editing.location ?? '');
    setWhatsapp(editing.whatsappUrl ?? '');
    const two = (n: number) => String(n).padStart(2, '0');
    const asDay = (d: Date) => `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()}`;
    const asTime = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}`;
    if (editing.startsAt) {
      setDay(asDay(editing.startsAt));
      setTime(asTime(editing.startsAt));
    }
    if (editing.endsAt) {
      setEndDay(asDay(editing.endsAt));
      setEndTime(asTime(editing.endsAt));
    }
  }, [visible, editing]);

  const reset = () => {
    setCover(null);
    setAudio(null);
    setTitle('');
    setDescription('');
    setDay('');
    setTime('');
    setPlace('');
    setEndDay('');
    setEndTime('');
    setWhatsapp('');
    setPrice('');
    setCategory(null);
    setError(null);
  };


  const close = () => {
    reset();
    onClose();
  };

  /** Elimina el curso. Modulos, lecciones y recursos caen en cascada. */
  const deleteCourse = async () => {
    if (!editing) return;
    // Se captura antes de cerrar: al cerrar, el padre deja de pasar `editing`.
    const target = editing;

    /*
      En iOS un Modal NO puede abrirse encima de otro. Esta hoja ya es un
      Modal, asi que el dialogo de confirmacion no llegaba a mostrarse y
      `confirm()` no resolvia nunca: la pantalla se quedaba congelada, con la
      hoja bloqueando y sin nada que pulsar.

      Se cierra la hoja y se espera a su animacion de salida antes de
      preguntar. Es el mismo patron que usa el menu de PostCard.
    */
    onClose();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const accepted = await confirm({
      title: 'Eliminar curso',
      message:
        'Se eliminarán sus módulos, lecciones y recursos. Esta acción no se puede deshacer.',
      confirmLabel: 'Eliminar',
      destructive: true,
    });
    if (!accepted) return;

    try {
      await CourseContentRepository.removeCourse(target.id);
      toast('Curso eliminado');
      onDeleted?.();
      onCreated?.();
    } catch (error) {
      notify(
        'No se pudo eliminar',
        error instanceof Error ? error.message : 'Puede que tenga compras asociadas.',
      );
    }
  };

  const chooseAudio = async () => {
    try {
      const picked = await pickAudio();
      if (picked) setAudio(picked);
    } catch {
      setError('No se pudo abrir el selector de archivos.');
    }
  };

  const chooseCover = async () => {
    try {
      // 16:9 es la proporcion de un banner de portada.
      const picked = await pickImage({ allowsEditing: false });
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
    if (isPodcast && !audio) {
      setError('Elige el archivo de audio del episodio.');
      return;
    }
    // La fecha es OPCIONAL: hay eventos que se anuncian antes de cerrarla.
    // Solo se valida si se ha escrito algo, y entonces hacen falta las dos
    // partes (una fecha sin hora no se puede guardar como instante).
    let startsAt: Date | null = null;
    if (isEvent && (day.trim() || time.trim())) {
      startsAt = parseDateTime(day, time);
      if (!startsAt) {
        setError('Para fijar la fecha necesito el día y la hora. Déjalos vacíos si aún no se sabe.');
        return;
      }
    }

    // El fin es opcional, pero si se rellena a medias hay que avisar.
    let endsAt: Date | null = null;
    if (isEvent && startsAt && (endDay.trim() || endTime.trim())) {
      endsAt = parseDateTime(endDay, endTime);
      if (!endsAt) {
        setError('Revisa el día y la hora de fin (dd/mm/aaaa y hh:mm).');
        return;
      }
      if (startsAt && endsAt < startsAt) {
        setError('El fin del evento no puede ser anterior a su inicio.');
        return;
      }
    }

    setSaving(true);
    setError(null);
    try {
      // La portada se sube primero: se guarda su RUTA, no una URL.
      const coverPath = cover ? (await uploadPostMedia(cover)).storagePath : null;

      if (isPodcast) {
        // Un episodio es una publicacion de audio: reutiliza la subida, el
        // firmado y los permisos que ya existen, sin una tabla nueva.
        const uploaded = await uploadPostMedia(audio!);
        await PostRepository.createPost(
          title.trim(),
          [uploaded],
          undefined,
          isPrivate ? PRIVATE_AUDIO_CATEGORY : category,
        );
      } else if (isEvent) {
        const data = {
          title: title.trim(),
          description: description.trim(),
          startsAt,
          endsAt,
          location: place.trim(),
          whatsappUrl: whatsapp.trim(),
          // `undefined` deja la portada intacta al editar; solo se envia si se
          // eligio una nueva.
          ...(coverPath ? { coverPath } : {}),
        };
        if (editing) await CatalogRepository.updateEvent(editing.id, data);
        else await CatalogRepository.createEvent({ ...data, coverPath });
      } else {
        const data = {
          title: title.trim(),
          description: description.trim(),
          price: Number(price) || 0,
          ...(coverPath ? { coverPath } : {}),
        };
        if (editing) await LearningRepository.updateCourse(editing.id, data);
        else await LearningRepository.createCourse({ ...data, currency: 'PEN', coverPath });
      }
      notify(
        editing
          ? isEvent ? 'Evento actualizado' : 'Curso actualizado'
          : isPodcast ? 'Episodio publicado'
          : isEvent ? 'Evento publicado' : 'Curso publicado',
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
        {editing
          ? isEvent ? 'Editar evento' : 'Editar curso'
          : isPrivate ? 'Audio privado'
          : isPodcast ? 'Nuevo episodio'
          : isEvent ? 'Nuevo evento' : 'Nuevo curso'}
      </Text>

      <ScrollView keyboardShouldPersistTaps="handled" style={styles.scroll}>
        {isPodcast ? (
          <Pressable
            onPress={chooseAudio}
            style={[styles.audioPicker, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}
            accessibilityRole="button"
            accessibilityLabel="Elegir archivo de audio"
          >
            <Feather name={audio ? 'music' : 'upload'} size={20} color={colors.text} />
            <Text variant="secondary" numberOfLines={1} color={audio ? colors.text : colors.textMuted}>
              {audio?.name ?? 'Elegir archivo de audio'}
            </Text>
          </Pressable>
        ) : (
        <Pressable
          onPress={chooseCover}
          style={[styles.cover, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}
          accessibilityRole="button"
          accessibilityLabel="Elegir portada"
        >
          {cover ? (
            // `contain` para que la vista previa muestre la portada entera, sin
            // recortar: es lo que se va a ver despues en la ficha.
            <ExpoImage source={{ uri: cover.uri }} style={StyleSheet.absoluteFill} contentFit="contain" />
          ) : (
            <View style={styles.coverEmpty}>
              <Feather name="image" size={22} color={colors.textMuted} />
              <Text variant="secondary" color={colors.textMuted}>
                {editing
                  ? 'Cambiar portada (opcional)'
                  : `Portada — se sube sin recortar (${isEvent ? 'banner 820x312' : 'imagen del curso'})`}
              </Text>
            </View>
          )}
        </Pressable>
        )}

        <Input
          label={isPodcast ? 'Nombre del audio' : isEvent ? 'Nombre del evento' : 'Nombre del curso'}
          value={title}
          onChangeText={setTitle}
          placeholder={isPodcast ? 'Episodio 1: Claridad' : isEvent ? 'Encuentro RENASER' : 'Liderazgo consciente'}
        />
        {!isPodcast ? (
        <Input
          label="Descripción"
          value={description}
          onChangeText={setDescription}
          placeholder="De qué trata"
          multiline
        />
        ) : null}

        {isPodcast && !isPrivate ? (
          <View style={styles.categories}>
            <Text variant="secondary" color={colors.textMuted}>Categoría</Text>
            <View style={styles.chips}>
              {CATEGORIES.map((c) => (
                <Chip
                  key={c.id}
                  label={c.label}
                  selected={category === c.id}
                  onPress={() => setCategory(category === c.id ? null : c.id)}
                />
              ))}
            </View>
          </View>
        ) : null}

        {isEvent ? (
          <>
            <DateField label="Día (opcional)" value={day} onChange={setDay} />
            <Input
              label="Hora (opcional)"
              value={time}
              onChangeText={setTime}
              placeholder="hh:mm"
            />
            <Input
              label="Lugar (opcional)"
              value={place}
              onChangeText={setPlace}
              placeholder="Dirección, enlace o «por confirmar»"
            />
            <DateField label="Día de fin (opcional)" value={endDay} onChange={setEndDay} />
            <Input
              label="Hora de fin (opcional)"
              value={endTime}
              onChangeText={setEndTime}
              placeholder="hh:mm"
            />
            <Input
              label="Grupo de WhatsApp (opcional)"
              value={whatsapp}
              onChangeText={setWhatsapp}
              placeholder="https://chat.whatsapp.com/..."
              autoCapitalize="none"
            />
          </>
        ) : isPodcast ? null : (
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
          label={
            editing
              ? 'Guardar cambios'
              : isPrivate ? 'Publicar audio privado'
              : isPodcast ? 'Publicar episodio'
              : isEvent ? 'Publicar evento' : 'Publicar curso'
          }
          onPress={() => void submit()}
          loading={saving}
          style={styles.submit}
        />

        {/* Eliminar el curso, solo al editar uno existente. */}
        {editing && kind === 'curso' ? (
          <Pressable
            onPress={() => void deleteCourse()}
            accessibilityRole="button"
            accessibilityLabel="Eliminar curso"
            style={({ pressed }) => [
              styles.delete,
              { borderColor: colors.danger, opacity: pressed ? 0.6 : 1 },
            ]}
          >
            <Feather name="trash-2" size={16} color={colors.danger} />
            <Text variant="body" weight="700" color={colors.danger}>
              Eliminar curso
            </Text>
          </Pressable>
        ) : null}
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
  categories: { gap: spacing.sm, marginBottom: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  audioPicker: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.md,
  },
  coverEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.xs },
  error: { marginTop: spacing.sm },
  delete: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: 48,
    borderWidth: 1,
    borderRadius: radius.pill,
    marginTop: spacing.md,
  },
  submit: { marginTop: spacing.lg, marginBottom: spacing.lg },
});
