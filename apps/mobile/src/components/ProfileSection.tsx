import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';

import { CreateCatalogSheet, type CatalogEditable } from '@/components/CreateCatalogSheet';
import { CreateTestimonialSheet, type TestimonialEditable } from '@/components/CreateTestimonialSheet';
import { SegmentedControl } from '@/components/SegmentedControl';
import { VideoPlayer } from '@/components/VideoPlayer';
import { Button } from '@/components/Button';
import { ListRow } from '@/components/ListRow';
import { PodcastList } from '@/components/PodcastList';
import { Text } from '@/components/Text';
import { AuthRepository } from '@/repositories/AuthRepository';
import { CatalogRepository } from '@/repositories/CatalogRepository';
import { LearningRepository } from '@/repositories/LearningRepository';
import { PostRepository } from '@/repositories/PostRepository';
import { TestimonialRepository } from '@/repositories/TestimonialRepository';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { confirm, notify } from '@/lib/confirm';
import type { Course, EventItem, Post, Testimonial, TestimonialFilter } from '@/types';

/** Secciones del perfil que se abren desde los accesos circulares. */
export type ProfileSectionKind = 'eventos' | 'cursos' | 'podcast' | 'testimonios';

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
};

/**
 * Eventos o cursos publicados por un perfil.
 *
 * Darren administra la aplicacion, asi que su perfil es donde viven los
 * eventos y los cursos: las tarjetas del inicio traen aqui a cualquier usuario.
 */
export function ProfileSection({ kind, profileId }: Props) {
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
   * Se recarga al volver a la pantalla. Sin esto, publicar un episodio (o un
   * evento) desde otra vista no se reflejaba aqui: la lista se habia pedido al
   * montar y no se volvia a pedir, asi que lo recien subido no aparecia.
   */
  useFocusEffect(reload);

  /** Alta desde la propia seccion; solo el administrador la ve. */
  const [creating, setCreating] = useState(false);
  /** Testimonio en edicion; solo lo abre el administrador. */
  const [editingTestimonial, setEditingTestimonial] = useState<TestimonialEditable | null>(null);
  const isAdmin = useAppStore((state) => state.user?.isAdmin === true);

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
            { media: 'audio', limit: 60 },
            profileId,
          ).then((list) => {
            // El episodio 1 es el mas antiguo; el backend devuelve al reves.
            if (alive) setEpisodes([...list].reverse());
          })
        : kind === 'testimonios'
        ? TestimonialRepository.list(
            TESTIMONIAL_FILTERS[testimonialFilter] ?? 'all',
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
            if (alive) setCourses(list);
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
  }, [kind, profileId, reloadKey, testimonialFilter]);

  const removeTestimonial = async (id: string) => {
    const accepted = await confirm({
      title: 'Eliminar testimonio',
      message: 'Esta acción no se puede deshacer.',
      confirmLabel: 'Eliminar',
      destructive: true,
    });
    if (!accepted) return;
    try {
      await TestimonialRepository.remove(id);
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

  // El podcast siempre pinta sus 30 filas, aunque aun no haya episodios: la
  // lista bloqueada es parte de lo que se quiere mostrar.
  if (kind === 'podcast') {
    return (
      <View>
        {isAdmin ? (
          <Button
            label="Agregar audio"
            variant="secondary"
            icon="plus"
            onPress={() => setCreating(true)}
          />
        ) : null}
        <PodcastList episodes={episodes} />
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

  // Galeria de testimonios: se ve dentro del perfil, como el podcast.
  if (kind === 'testimonios') {
    return (
      <View>
        {isAdmin ? (
          <Button
            label="Agregar testimonio"
            variant="secondary"
            icon="plus"
            onPress={() => setCreating(true)}
          />
        ) : null}

        <SegmentedControl
          options={['Todos', 'Fotos', 'Videos']}
          selectedIndex={testimonialFilter}
          onChange={setTestimonialFilter}
          style={styles.filters}
        />

        {testimonials.length === 0 ? (
          <View style={styles.center}>
            <Text variant="secondary" color={colors.textMuted} style={styles.centerText}>
              Aún no hay testimonios publicados.
            </Text>
          </View>
        ) : (
          <View style={styles.gallery}>
            {testimonials.map((item) => (
              <View
                key={item.id}
                style={[styles.testimonialCard, { borderColor: colors.border }]}
              >
                {/*
                  Sin menu contextual ni arrastre en web: no impide guardar el
                  archivo (el navegador ya lo descargo para pintarlo), pero
                  evita la copia casual. Los videos lo traen del propio player.
                */}
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
                  {isAdmin ? (
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
                        accessibilityLabel="Editar testimonio"
                      >
                        <Feather name="edit-2" size={16} color={colors.textMuted} />
                      </Pressable>
                      <Pressable
                        onPress={() => void removeTestimonial(item.id)}
                        hitSlop={10}
                        accessibilityRole="button"
                        accessibilityLabel="Eliminar testimonio"
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
  if (items.length === 0) {
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
            <ListRow
              key={event.id}
              title={event.title}
              subtitle={`${event.date} • ${event.location}`}
              leftIcon="calendar"
              rightIcon={isAdmin ? 'edit-2' : 'chevron-right'}
              onPress={() =>
                isAdmin
                  ? setEditing({
                      id: event.id,
                      title: event.title,
                      description: event.description,
                      startsAt: event.startsAtDate ?? null,
                      location: event.location,
                    })
                  : router.push('/events')
              }
            />
          ))
        : courses.map((course) => (
            <ListRow
              key={course.id}
              title={course.title}
              subtitle={course.subtitle || 'Ver programa'}
              leftIcon="book"
              rightIcon={isAdmin ? 'edit-2' : 'chevron-right'}
              onPress={() =>
                isAdmin
                  ? setEditing({
                      id: course.id,
                      title: course.title,
                      description: course.description,
                      price: course.price,
                    })
                  : router.push(`/course/${course.id}` as never)
              }
            />
          ))}
      {editing ? (
        <CreateCatalogSheet
          kind={kind === 'eventos' ? 'evento' : 'curso'}
          visible
          editing={editing}
          onClose={() => setEditing(null)}
          onCreated={reload}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.xxl },
  centerText: { textAlign: 'center' },
  list: { marginTop: spacing.md },
  filters: { marginTop: spacing.md },
  gallery: { marginTop: spacing.md, gap: spacing.md },
  testimonialCard: { borderWidth: 1, borderRadius: radius.lg, overflow: 'hidden' },
  testimonialMedia: { width: '100%', height: 220 },
  testimonialFooter: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md },
});
