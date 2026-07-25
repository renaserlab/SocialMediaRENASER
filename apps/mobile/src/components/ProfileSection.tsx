import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';

import { CourseCard } from '@/components/CourseCard';
import { CreateCatalogSheet, type CatalogEditable } from '@/components/CreateCatalogSheet';
import { CreateTestimonialSheet, type TestimonialEditable } from '@/components/CreateTestimonialSheet';
import { SegmentedControl } from '@/components/SegmentedControl';
import { VideoPlayer } from '@/components/VideoPlayer';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { EventCard } from '@/components/EventCard';
import { EventDetailSheet } from '@/components/EventDetailSheet';
import { ListRow } from '@/components/ListRow';
import { PodcastList } from '@/components/PodcastList';
import { CATEGORIES, PRIVATE_AUDIO_CATEGORY, type CategoryId } from '@/data/categories';
import { Text } from '@/components/Text';
import { AuthRepository } from '@/repositories/AuthRepository';
import { CatalogRepository } from '@/repositories/CatalogRepository';
import { LearningRepository } from '@/repositories/LearningRepository';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import { PostRepository } from '@/repositories/PostRepository';
import { TestimonialRepository } from '@/repositories/TestimonialRepository';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { confirm, notify } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import type { Course, EventItem, Post, Testimonial, TestimonialFilter } from '@/types';

/** Secciones del perfil que se abren desde los accesos circulares. */
export type ProfileSectionKind = 'eventos' | 'cursos' | 'podcast' | 'testimonios';

/**
 * Que se dice en cada seccion cuando el perfil no administra la aplicacion.
 * Reunido aqui para que anadir una seccion sea anadir una entrada.
 */
const ADMIN_SECTIONS: Partial<
  Record<
    ProfileSectionKind,
    { icon: 'headphones' | 'calendar' | 'book' | 'camera'; title: string; body: string; action: string }
  >
> = {
  podcast: {
    icon: 'headphones',
    title: 'Aún no tienes podcast',
    body: 'Los episodios de RENASER están en el perfil de Darren.',
    action: 'Ir al podcast de RENASER',
  },
  eventos: {
    icon: 'calendar',
    title: 'Aún no tienes eventos',
    body: 'Los próximos encuentros de RENASER están en el perfil de Darren.',
    action: 'Ver eventos de RENASER',
  },
  cursos: {
    icon: 'book',
    title: 'Aún no tienes cursos',
    body: 'Los programas de RENASER están en el perfil de Darren.',
    action: 'Ver cursos de RENASER',
  },
  testimonios: {
    icon: 'camera',
    title: 'Aún no tienes reseñas',
    body: 'Las reseñas de la comunidad están en el perfil de Darren.',
    action: 'Ver reseñas de RENASER',
  },
};

/** Orden de las pestañas de la galeria: Todos / Fotos / Videos. */
const TESTIMONIAL_FILTERS: TestimonialFilter[] = ['all', 'image', 'video'];

/**
 * En web se desactivan el menu contextual y el arrastre sobre el contenido.
 *
 * No impide guardarlo —el navegador ya lo descargo para pintarlo— pero evita
 * la copia casual. Los videos ya lo traen de VideoPlayer.web.
 */
const noSaveProps =
  Platform.OS === 'web'
    ? ({
        onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
        draggable: false,
      } as Record<string, unknown>)
    : {};

type Props = {
  kind: ProfileSectionKind;
  /** Perfil dueño de la sección: solo se muestra lo que ha creado. */
  profileId?: string;
  /**
   * Si el dueño del perfil administra la aplicación. El podcast, los eventos
   * y los cursos son suyos: en un perfil normal no hay nada que enseñar.
   */
  ownerIsAdmin?: boolean;
  /** Si la persona conectada es el dueño de este perfil. */
  isOwner?: boolean;
};

/**
 * Eventos o cursos publicados por un perfil.
 *
 * Darren administra la aplicacion, asi que su perfil es donde viven los
 * eventos y los cursos: las tarjetas del inicio traen aqui a cualquier usuario.
 */
export function ProfileSection({ kind, profileId, ownerIsAdmin = false, isOwner = false }: Props) {
  const { colors } = useAppTheme();
  const router = useRouter();

  const [events, setEvents] = useState<EventItem[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [episodes, setEpisodes] = useState<Post[]>([]);
  const [testimonials, setTestimonials] = useState<Testimonial[]>([]);
  /** Filtro de la galeria: 0 todos, 1 fotos, 2 videos. */
  const [testimonialFilter, setTestimonialFilter] = useState(0);
  const [loading, setLoading] = useState(true);
  /** Elemento en edicion; solo el administrador puede abrirlo. */
  const [editing, setEditing] = useState<CatalogEditable | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  /**
   * Lleva a la seccion equivalente en el perfil del administrador, que es
   * donde vive el contenido de RENASER. El id se resuelve, no va escrito.
   */
  const openAdminSection = useCallback(
    async (target: ProfileSectionKind) => {
      try {
        const featured = await ProfileRepository.listFeatured();
        const admin = featured.find((m) => m.isAdmin) ?? featured[0];
        if (admin) {
          router.push({
            pathname: '/profile/[id]',
            params: { id: admin.id, section: target },
          } as never);
        }
      } catch {
        // Sin red no se puede resolver; se puede llegar desde el inicio.
      }
    },
    [router],
  );

  /**
   * Se recarga al volver a la pantalla. Sin esto, publicar un episodio (o un
   * evento) desde otra vista no se reflejaba aqui: la lista se habia pedido al
   * montar y no se volvia a pedir, asi que lo recien subido no aparecia.
   */
  useFocusEffect(reload);

  /** Alta desde la propia seccion; solo el administrador la ve. */
  const [creating, setCreating] = useState(false);
  /** Testimonio en edicion; solo lo abre el administrador. */
  const [editingTestimonial, setEditingTestimonial] = useState<TestimonialEditable | null>(null);
  /** Filtro del podcast; `null` = Todos. */
  const [category, setCategory] = useState<CategoryId | null>(null);
  /** Evento cuya ficha se esta viendo. */
  const [detail, setDetail] = useState<EventItem | null>(null);
  const isAdmin = useAppStore((state) => state.user?.isAdmin === true);
  /**
   * Puede publicar y editar en ESTA seccion: en su propio perfil cualquiera,
   * y quien administra en cualquiera (para moderar).
   *
   * Antes solo mandaba `isAdmin`, de modo que la comunidad no podia compartir
   * sus cursos ni sus resenas. Quien decide de verdad es el servidor: la
   * comprobacion de aqui solo evita ensenar botones que iban a fallar.
   */
  const canManage = isOwner || isAdmin;

  useEffect(() => {
    if (!AuthRepository.enabled) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    const request =
      kind === 'podcast'
        ? PostRepository.listByAuthor(
            profileId ?? '',
            {
              media: 'audio',
              limit: 60,
              excludeCategory: PRIVATE_AUDIO_CATEGORY,
              ...(category ? { category } : {}),
            },
            profileId,
          ).then((list) => {
            // El episodio 1 es el mas antiguo; el backend devuelve al reves.
            if (alive) setEpisodes([...list].reverse());
          })
        : kind === 'testimonios'
        ? TestimonialRepository.list(
            TESTIMONIAL_FILTERS[testimonialFilter] ?? 'all',
            profileId,
          ).then((list) => {
            if (alive) setTestimonials(list);
          })
        : kind === 'eventos'
        ? CatalogRepository.listEvents().then((page) => {
            if (alive) {
              // Solo los que organiza este perfil.
              setEvents(
                profileId
                  ? page.items.filter((e) => !e.organizerId || e.organizerId === profileId)
                  : page.items,
              );
            }
          })
        : LearningRepository.listCourses().then((list) => {
            // Solo los que publica este perfil, igual que con los eventos.
            if (alive) {
              setCourses(
                profileId ? list.filter((c) => !c.authorId || c.authorId === profileId) : list,
              );
            }
          });

    request
      .catch(() => {
        if (alive) {
          setEvents([]);
          setCourses([]);
          setEpisodes([]);
          setTestimonials([]);
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
    // `testimonialFilter` es de la galeria y `category` del podcast: cada
    // seccion recarga cuando cambia el suyo.
  }, [kind, profileId, reloadKey, testimonialFilter, category]);

  const removeTestimonial = async (id: string) => {
    const accepted = await confirm({
      title: 'Eliminar reseña',
      message: 'Esta acción no se puede deshacer.',
      confirmLabel: 'Eliminar',
      destructive: true,
    });
    if (!accepted) return;
    try {
      await TestimonialRepository.remove(id);
      toast('Reseña eliminada');
      reload();
    } catch {
      notify('No se pudo eliminar', 'Inténtalo de nuevo.');
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.textMuted} />
      </View>
    );
  }

  // El podcast esta disponible en cualquier perfil si es dueño o si no se requiere ser admin.
  if (kind !== 'podcast' && !ownerIsAdmin && ADMIN_SECTIONS[kind]) {
    const copy = ADMIN_SECTIONS[kind]!;
    return (
      <View style={styles.center}>
        <Feather name={copy.icon} size={30} color={colors.textMuted} />
        <Text variant="body" weight="700" style={styles.centerText}>
          {copy.title}
        </Text>
        <Text variant="secondary" color={colors.textMuted} style={styles.centerText}>
          {copy.body}
        </Text>
        <Button
          label={copy.action}
          variant="secondary"
          icon={copy.icon}
          onPress={() => void openAdminSection(kind)}
          style={styles.centerAction}
        />
      </View>
    );
  }

  if (kind === 'podcast') {
    const canAddAudio = canManage;
    return (
      <View>
        {/* Filtros por categoria; "Todos" es simplemente sin filtro. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filters}
        >
          <Chip label="Todos" selected={category === null} onPress={() => setCategory(null)} />
          {CATEGORIES.map((c) => (
            <Chip
              key={c.id}
              label={c.label}
              selected={category === c.id}
              onPress={() => setCategory(c.id)}
            />
          ))}
        </ScrollView>

        {canAddAudio ? (
          <Button
            label="Agregar audio"
            variant="secondary"
            icon="plus"
            onPress={() => setCreating(true)}
          />
        ) : null}
        <PodcastList
          episodes={episodes}
          showLockedSlots={category === null && ownerIsAdmin}
          onEdit={canAddAudio ? (id) => router.push(`/edit-post/${id}` as never) : undefined}
        />
        {creating ? (
          <CreateCatalogSheet
            kind="podcast"
            visible
            onClose={() => setCreating(false)}
            onCreated={reload}
          />
        ) : null}
      </View>
    );
  }

  // Galeria de testimonios / reseñas: se ve dentro del perfil, como el podcast.
  if (kind === 'testimonios') {
    return (
      <View>
        {canManage ? (
          <Button
            label="Agregar reseña"
            variant="secondary"
            icon="plus"
            onPress={() => setCreating(true)}
          />
        ) : null}

        <SegmentedControl
          options={['Todos', 'Fotos', 'Videos']}
          selectedIndex={testimonialFilter}
          onChange={setTestimonialFilter}
          style={styles.testimonialFilters}
        />

        {testimonials.length === 0 ? (
          <View style={styles.center}>
            <Text variant="secondary" color={colors.textMuted} style={styles.centerText}>
              Aún no hay reseñas publicadas.
            </Text>
          </View>
        ) : (
          <View style={styles.gallery}>
            {testimonials.map((item) => (
              <View
                key={item.id}
                style={[styles.testimonialCard, { borderColor: colors.border }]}
              >
                <View {...noSaveProps}>
                  {item.mediaType === 'video' && item.mediaUrl ? (
                    <VideoPlayer uri={item.mediaUrl} style={styles.testimonialMedia} nativeControls />
                  ) : (
                    <ExpoImage
                      source={item.mediaUrl ? { uri: item.mediaUrl } : undefined}
                      style={styles.testimonialMedia}
                      contentFit="cover"
                      transition={150}
                    />
                  )}
                </View>
                <View style={styles.testimonialFooter}>
                  <Text variant="body" weight="600" style={{ flex: 1 }}>
                    {item.caption || (item.mediaType === 'video' ? 'Video' : 'Foto')}
                  </Text>
                  {canManage ? (
                    <React.Fragment>
                      <Pressable
                        onPress={() =>
                          setEditingTestimonial({
                            id: item.id,
                            caption: item.caption,
                            mediaType: item.mediaType,
                            mediaUrl: item.mediaUrl,
                          })
                        }
                        hitSlop={10}
                        accessibilityRole="button"
                        accessibilityLabel="Editar reseña"
                      >
                        <Feather name="edit-2" size={16} color={colors.textMuted} />
                      </Pressable>
                      <Pressable
                        onPress={() => void removeTestimonial(item.id)}
                        hitSlop={10}
                        accessibilityRole="button"
                        accessibilityLabel="Eliminar reseña"
                      >
                        <Feather name="trash-2" size={16} color={colors.textMuted} />
                      </Pressable>
                    </React.Fragment>
                  ) : null}
                </View>
              </View>
            ))}
          </View>
        )}

        {creating ? (
          <CreateTestimonialSheet visible onClose={() => setCreating(false)} onCreated={reload} />
        ) : null}
        {editingTestimonial ? (
          <CreateTestimonialSheet
            visible
            editing={editingTestimonial}
            onClose={() => setEditingTestimonial(null)}
            onCreated={reload}
          />
        ) : null}
      </View>
    );
  }

  const items = kind === 'eventos' ? events : courses;
  // Vacio: los eventos no ofrecen alta desde aqui (se crean en Inicio); los
  // cursos si, para que Darren pueda empezar uno desde su propio perfil.
  if (items.length === 0 && !(kind === 'cursos' && canManage)) {
    return (
      <View style={styles.center}>
        <Text variant="secondary" color={colors.textMuted} style={styles.centerText}>
          {kind === 'eventos'
            ? 'Aún no hay eventos publicados.'
            : 'Aún no hay cursos publicados.'}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.list}>
      {kind === 'eventos'
        ? events.map((event) => (
            <EventCard
              key={event.id}
              event={event}
              onPress={() => setDetail(event)}
              onEdit={
                canManage
                  ? () =>
                      setEditing({
                        id: event.id,
                        title: event.title,
                        description: event.description,
                        startsAt: event.startsAtDate ?? null,
                        endsAt: event.endsAtDate ?? null,
                        location: event.location,
                        whatsappUrl: event.whatsappUrl ?? '',
                      })
                  : undefined
              }
            />
          ))
        : courses.map((course) => (
            // La fila abre el curso (temario y contenido); el lapiz edita sus
            // datos sin salir del perfil. Van como hermanos, no anidados.
            <CourseCard
              key={course.id}
              course={course}
              onPress={() => router.push(`/course/${course.id}` as never)}
              onEdit={
                canManage
                  ? () =>
                      setEditing({
                        id: course.id,
                        title: course.title,
                        description: course.description,
                        price: course.price,
                      })
                  : undefined
              }
            />
          ))}

      {/* Alta de un curso nuevo, debajo de los ya publicados. */}
      {kind === 'cursos' && canManage ? (
        <Button
          label="Agregar curso"
          variant="secondary"
          icon="plus"
          onPress={() => setCreating(true)}
        />
      ) : null}

      <EventDetailSheet event={detail} onClose={() => setDetail(null)} />

      {editing ? (
        <CreateCatalogSheet
          kind={kind === 'eventos' ? 'evento' : 'curso'}
          visible
          editing={editing}
          onClose={() => setEditing(null)}
          onCreated={reload}
        />
      ) : null}

      {/* Crear (sin `editing`) es distinto de editar: la misma hoja, vacia. */}
      {creating && kind === 'cursos' ? (
        <CreateCatalogSheet
          kind="curso"
          visible
          onClose={() => setCreating(false)}
          onCreated={reload}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', gap: spacing.sm, paddingVertical: spacing.xxl },
  centerText: { textAlign: 'center' },
  centerAction: { marginTop: spacing.md },
  list: { marginTop: spacing.md },
  // `filters` es de los chips de categoria del podcast. El de la galeria se
  // llama `testimonialFilters` para no pisarlo: ambos se anadieron a la vez.
  filters: { flexDirection: 'row', gap: spacing.sm, paddingVertical: spacing.sm },
  testimonialFilters: { marginTop: spacing.md },
  gallery: { marginTop: spacing.md, gap: spacing.md },
  testimonialCard: { borderWidth: 1, borderRadius: radius.lg, overflow: 'hidden' },
  testimonialMedia: { width: '100%', height: 220 },
  testimonialFooter: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md },
});
