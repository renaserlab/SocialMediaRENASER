import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { DateField } from '@/components/DateField';
import { InlineError } from '@/components/InlineError';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { FEATURE_PURCHASES } from '@/config/features';
import { SegmentedControl } from '@/components/SegmentedControl';
import { SelectorDeTemas } from '@/components/SelectorDeTemas';
import {
  aCentavos,
  aTextoEditable,
  MONEDAS_DE_CURSO,
  monedaDeCurso,
  type MonedaDeCurso,
} from '@/lib/dinero';
import { SelectorDeCategoria } from '@/components/SelectorDeCategoria';
import { PRIVATE_AUDIO_CATEGORY } from '@/data/categories';
import { useAppStore } from '@/store/useAppStore';
import { afterSheetClose, closeThen } from '@/lib/afterSheetClose';
import { confirm, notify } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import { CourseContentRepository } from '@/repositories/CourseContentRepository';
import { CatalogRepository } from '@/repositories/CatalogRepository';
import { LearningRepository } from '@/repositories/LearningRepository';
import { pickAudio, pickImage, uploadPostMedia, type PickedMedia } from '@/services/storage';
import { PostRepository } from '@/repositories/PostRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

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
  /** Solo cursos: precio en la unidad MENOR. Ver `lib/dinero.ts`. */
  priceMinor?: number;
  /** Solo cursos: la moneda en la que está puesto ese precio. */
  currency?: string;
  /** Solo cursos: temas ya elegidos. */
  topicIds?: string[];
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
  const { t } = useTranslation();
  /*
    De quien seran las categorias que se ofrecen: de quien esta publicando. El
    backend crea el episodio a nombre de quien manda la peticion, asi que
    ofrecerle las de otra persona daria una categoria que no es suya.
  */
  const autorId = useAppStore((state) => state.user?.id ?? null);
  const router = useRouter();
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
  /**
   * Gratuito o de pago. Es una decision aparte del importe porque son dos
   * preguntas distintas: «se cobra?» y «cuanto?». Sin separarlas, un campo de
   * precio vacio significaba a la vez «gratis» y «todavia no lo he decidido».
   */
  const [dePago, setDePago] = useState(false);
  /** En qué moneda se cobra. Solo cuenta si el curso es de pago. */
  const [moneda, setMoneda] = useState<MonedaDeCurso>('PEN');
  const [temas, setTemas] = useState<string[]>([]);
  /** Solo podcast: categoria del episodio, para los filtros. */
  /** Categoria elegida: el ID de una del creador, o null. */
  const [category, setCategory] = useState<string | null>(null);
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
    setPrice(aTextoEditable(editing.priceMinor ?? 0));
    setDePago((editing.priceMinor ?? 0) > 0);
    setMoneda(monedaDeCurso(editing.currency));
    setTemas(editing.topicIds ?? []);
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
    setMoneda('PEN');
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
      title: t('catalog.deleteCourse'),
      message: t('catalog.deleteCourseBody'),
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (!accepted) return;

    try {
      await CourseContentRepository.removeCourse(target.id);
      toast(t('catalog.courseDeleted'));
      onDeleted?.();
      onCreated?.();
    } catch (error) {
      notify(
        t('common.deleteFailed'),
        error instanceof Error ? error.message : t('catalog.maybeHasPurchases'),
      );
    }
  };

  const chooseAudio = async () => {
    try {
      const picked = await pickAudio();
      if (picked) setAudio(picked);
    } catch {
      setError(t('chat.pickerFailed'));
    }
  };

  const chooseCover = async () => {
    try {
      // 16:9 es la proporcion de un banner de portada.
      const picked = await pickImage({ allowsEditing: false });
      if (picked) setCover(picked);
    } catch {
      setError(t('catalog.galleryFailed'));
    }
  };

  const submit = async () => {
    if (!title.trim()) {
      // Una frase entera por tipo: «el nombre del» + la palabra suelta no se
      // recoloca bien en un idioma que ordene las palabras de otra forma.
      setError(
        isPodcast
          ? t('catalog.needNameAudio')
          : isEvent
            ? t('catalog.needNameEvent')
            : t('catalog.needNameCourse'),
      );
      return;
    }
    if (isPodcast && !audio) {
      setError(t('catalog.needAudioFile'));
      return;
    }
    // La fecha es OPCIONAL: hay eventos que se anuncian antes de cerrarla.
    // Solo se valida si se ha escrito algo, y entonces hacen falta las dos
    // partes (una fecha sin hora no se puede guardar como instante).
    let startsAt: Date | null = null;
    if (isEvent && (day.trim() || time.trim())) {
      startsAt = parseDateTime(day, time);
      if (!startsAt) {
        setError(t('catalog.needDayAndTime'));
        return;
      }
    }

    // El fin es opcional, pero si se rellena a medias hay que avisar.
    let endsAt: Date | null = null;
    if (isEvent && startsAt && (endDay.trim() || endTime.trim())) {
      endsAt = parseDateTime(endDay, endTime);
      if (!endsAt) {
        setError(t('catalog.checkEndDate'));
        return;
      }
      if (startsAt && endsAt < startsAt) {
        setError(t('catalog.endBeforeStart'));
        return;
      }
    }

    setSaving(true);
    setError(null);
    //: El curso que se acaba de crear, para abrir su asistente al terminar.
    let nuevoCurso: string | null = null;
    let nuevoEvento: string | null = null;
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
        else {
          const creado = await CatalogRepository.createEvent({ ...data, coverPath });
          nuevoEvento = creado.id;
        }
      } else {
        // El precio se lee UNA vez y en un sitio (`lib/dinero.ts`): repartir
        // el calculo por los componentes acaba en dos importes distintos para
        // el mismo curso.
        let priceMinor = 0;
        if (dePago) {
          const leido = aCentavos(price, t);
          if (!leido.ok) {
            setError(leido.motivo);
            setSaving(false);
            return;
          }
          if (leido.centavos === 0) {
            setError(t('catalog.priceAboveZero'));
            setSaving(false);
            return;
          }
          priceMinor = leido.centavos;
        }
        const data = {
          title: title.trim(),
          description: description.trim(),
          priceMinor,
          // La moneda va con el precio, también al editar: un curso de pago
          // cuyo precio se cambia de soles a dólares tiene que guardarlo.
          ...(dePago ? { currency: moneda } : {}),
          topicIds: temas,
          ...(coverPath ? { coverPath } : {}),
        };
        if (editing) await LearningRepository.updateCourse(editing.id, data);
        else {
          const creado = await LearningRepository.createCourse({
            // Un curso gratuito nace en soles, como siempre.
            currency: 'PEN',
            ...data,
            coverPath,
          });
          nuevoCurso = creado.id;
        }
      }
      onCreated?.();
      const hecho = editing
        ? isEvent ? t('catalog.eventUpdated') : t('catalog.courseUpdated')
        : isPodcast ? t('catalog.episodePublished')
        : isEvent ? t('catalog.eventDraftCreated') : t('catalog.courseDraftCreated');
      /*
        UN CURSO RECIEN CREADO NO ESTA TERMINADO, y esta hoja no puede
        terminarlo: le faltan el temario, lo que se aprende, el nivel y la
        vista previa. Antes se cerraba aqui y el borrador se quedaba en una
        lista, sin que nada dijera que el siguiente paso existia. Se abre el
        asistente, que es donde se completa.

        UN EVENTO RECIEN CREADO YA NO SE PUBLICA SOLO. Nace borrador y pasa por
        admision, asi que el aviso decia «Evento publicado» sobre algo que no
        se ve en ningun sitio. Se lleva a su borrador, que es donde se completa
        y desde donde se envia a revision.
      */
      const destino = nuevoCurso
        ? `/editar-curso/${nuevoCurso}`
        : nuevoEvento
          ? `/editar-evento/${nuevoEvento}`
          : null;
      // El aviso va DESPUES de cerrar. Mientras la hoja (un Modal) siga
      // montada, en iOS tapa cualquier cosa que se pinte por encima: el
      // mensaje de exito no llegaba a verse nunca.
      close();
      if (destino === null) {
        toast(hecho);
      } else {
        /*
          SE ESPERA A QUE LA HOJA SE HAYA IDO ANTES DE CAMBIAR DE PANTALLA
          (13/10/2026). Se cerraba y se navegaba en el mismo instante: la hoja
          es un Modal —otra ventana, con su velo oscuro— y todavia estaba en
          pantalla, fundiendose, cuando la pila empezaba a meter el asistente.
          Es la regla de `lib/afterSheetClose`, que esta misma hoja ya cumplia
          al borrar y aqui no; y es donde se vio la pantalla gris al terminar
          de crear un curso o un evento. El aviso sale al llegar.
        */
        await afterSheetClose();
        router.push(destino as never);
        toast(hecho);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('create.publishFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet visible={visible} onClose={close}>
      <Text style={styles.sheetTitle} color={colors.text}>
        {editing
          ? isEvent ? t('catalog.editEvent') : t('catalog.editCourse')
          : isPrivate ? t('home.privateAudio')
          : isPodcast ? t('catalog.newEpisode')
          : isEvent ? t('catalog.newEvent') : t('catalog.newCourse')}
      </Text>

      <ScrollView keyboardShouldPersistTaps="handled" style={styles.scroll}>
        {isPodcast ? (
          <Pressable
            onPress={chooseAudio}
            style={[styles.audioPicker, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}
            accessibilityRole="button"
            accessibilityLabel={t('catalog.pickAudioFile')}
          >
            <Feather name={audio ? 'music' : 'upload'} size={20} color={colors.text} />
            <Text variant="secondary" numberOfLines={1} color={audio ? colors.text : colors.textMuted}>
              {audio?.name ?? t('catalog.pickAudioFile')}
            </Text>
          </Pressable>
        ) : (
        <Pressable
          onPress={chooseCover}
          style={[styles.cover, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}
          accessibilityRole="button"
          accessibilityLabel={t('catalog.pickCover')}
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
                  ? t('catalog.changeCover')
                  : isEvent
                    ? t('catalog.coverHintEvent')
                    : t('catalog.coverHintCourse')}
              </Text>
            </View>
          )}
        </Pressable>
        )}

        <Input
          label={
            isPodcast
              ? t('catalog.audioName')
              : isEvent
                ? t('catalog.eventName')
                : t('catalog.courseName')
          }
          value={title}
          onChangeText={setTitle}
          placeholder={
            isPodcast
              ? t('catalog.audioNameExample')
              : isEvent
                ? t('catalog.eventNameExample')
                : t('catalog.courseNameExample')
          }
        />
        {!isPodcast ? (
        <Input
          label={t('lesson.description')}
          value={description}
          onChangeText={setDescription}
          placeholder={t('catalog.descriptionPlaceholder')}
          multiline
        />
        ) : null}

        {/*
          Las categorias son las del creador, no tres fijas escritas en el
          codigo. Se pueden crear aqui mismo: el momento en que uno se da
          cuenta de que le falta «Carpinteria» es justo cuando esta subiendo un
          audio de carpinteria.
        */}
        {isPodcast && !isPrivate ? (
          <View style={styles.categories}>
            <SelectorDeCategoria
              ownerId={autorId}
              valor={category}
              alCambiar={setCategory}
            />
          </View>
        ) : null}

        {isEvent ? (
          <>
            <DateField label={t('catalog.day')} value={day} onChange={setDay} />
            <Input
              label={t('catalog.time')}
              value={time}
              onChangeText={setTime}
              placeholder="hh:mm"
            />
            <Input
              label={t('catalog.place')}
              value={place}
              onChangeText={setPlace}
              placeholder={t('catalog.placePlaceholder')}
            />
            <DateField label={t('catalog.endDay')} value={endDay} onChange={setEndDay} />
            <Input
              label={t('catalog.endTime')}
              value={endTime}
              onChangeText={setEndTime}
              placeholder="hh:mm"
            />
            <Input
              label={t('catalog.whatsappGroup')}
              value={whatsapp}
              onChangeText={setWhatsapp}
              placeholder="https://chat.whatsapp.com/..."
              autoCapitalize="none"
            />
          </>
        ) : isPodcast ? null : (
          <>
            {/*
              De que trata el curso. Es lo que permite recomendarlo a quien
              queria aprender justo eso; sin un tema, un curso solo se encuentra
              buscandolo por su nombre. El selector se esconde solo si el
              servidor todavia no puede guardarlos.
            */}
            <Text style={[styles.etiqueta, { color: colors.textMuted }]}>
              {t('catalog.whatWillTheyLearn')}
            </Text>
            <SelectorDeTemas
              seleccionados={temas}
              alCambiar={setTemas}
              para="curso"
              maximo={5}
            />

            {/*
              CONFIGURAR EL PRECIO Y COBRAR SON DOS COSAS DISTINTAS. Que todavia
              no haya pasarela no puede impedir que el creador diga cuanto vale
              su curso: eso es un dato del curso, no una venta. Lo que no se
              hace es ofrecerle a nadie un boton de comprar que no lleva a
              ninguna parte.
            */}
            <Text style={[styles.etiqueta, { color: colors.textMuted }]}>
              {t('catalog.accessType')}
            </Text>
            <SegmentedControl
              options={[t('catalog.free'), t('catalog.paid')]}
              selectedIndex={dePago ? 1 : 0}
              onChange={(indice) => setDePago(indice === 1)}
            />
            {dePago ? (
              <>
                <Text style={[styles.etiqueta, { color: colors.textMuted }]}>
                  {t('catalog.currency')}
                </Text>
                <SegmentedControl
                  options={MONEDAS_DE_CURSO.map((codigo) => t(`catalog.currency${codigo}`))}
                  selectedIndex={MONEDAS_DE_CURSO.indexOf(moneda)}
                  onChange={(indice) => setMoneda(MONEDAS_DE_CURSO[indice] ?? 'PEN')}
                />
                <Input
                  label={t('wizard.priceIn', { moneda })}
                  value={price}
                  onChangeText={setPrice}
                  placeholder="49.90"
                  keyboardType="decimal-pad"
                />
                {!FEATURE_PURCHASES ? (
                  <Text style={[styles.aviso, { color: colors.textMuted }]}>
                    {t('catalog.salesDisabled')}
                  </Text>
                ) : null}
              </>
            ) : null}
          </>
        )}

        {/*
          La ficha completa de un curso no cabe aqui: nivel, idioma, lo que se
          aprende, para quien es, el temario y la vista previa viven en el
          asistente. Esta hoja se queda con lo rapido —nombre, descripcion,
          portada, temas y precio— y ofrece la puerta al resto en vez de
          fingir que esto es todo lo que hay.
        */}
        {editing && kind === 'curso' ? (
          <Pressable
            onPress={() => {
              const destino = editing.id;
              // Primero se va la hoja; despues se cambia de pantalla.
              closeThen(close, () => router.push(`/editar-curso/${destino}` as never));
            }}
            accessibilityRole="button"
            accessibilityLabel={t('catalog.openWizard')}
            style={({ pressed }) => [
              styles.asistente,
              { borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
            ]}
          >
            <Feather name="sliders" size={16} color={colors.text} />
            <View style={{ flex: 1 }}>
              <Text variant="secondary" weight="700">
                {t('catalog.wizardTitle')}
              </Text>
              <Text variant="caption" color={colors.textMuted}>
                {t('catalog.wizardBody')}
              </Text>
            </View>
            <Feather name="chevron-right" size={16} color={colors.textMuted} />
          </Pressable>
        ) : null}

        <InlineError message={error} />

        <Button
          label={
            editing
              ? t('common.saveChanges')
              : isPrivate ? t('catalog.publishPrivateAudio')
              : isPodcast ? t('catalog.publishEpisode')
              : isEvent ? t('catalog.publishEvent') : t('catalog.publishCourse')
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
            accessibilityLabel={t('catalog.deleteCourse')}
            style={({ pressed }) => [
              styles.delete,
              { borderColor: colors.danger, opacity: pressed ? 0.6 : 1 },
            ]}
          >
            <Feather name="trash-2" size={16} color={colors.danger} />
            <Text variant="body" weight="700" color={colors.danger}>
              {t('catalog.deleteCourse')}
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  etiqueta: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  aviso: { fontSize: 12, lineHeight: 17 },
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
  audioPicker: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.md,
  },
  coverEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.xs },
  asistente: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginTop: spacing.md,
    minHeight: 56,
  },
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
