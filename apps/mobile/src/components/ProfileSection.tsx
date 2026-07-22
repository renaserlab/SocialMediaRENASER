import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { CreateCatalogSheet, type CatalogEditable } from '@/components/CreateCatalogSheet';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { EventCard } from '@/components/EventCard';
import { EventDetailSheet } from '@/components/EventDetailSheet';
import { ListRow } from '@/components/ListRow';
import { PodcastList } from '@/components/PodcastList';
import { CATEGORIES, type CategoryId } from '@/data/categories';
import { Text } from '@/components/Text';
import { AuthRepository } from '@/repositories/AuthRepository';
import { CatalogRepository } from '@/repositories/CatalogRepository';
import { LearningRepository } from '@/repositories/LearningRepository';
import { PostRepository } from '@/repositories/PostRepository';
import { useAppStore } from '@/store/useAppStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Course, EventItem, Post } from '@/types';

/** Secciones del perfil que se abren desde los accesos circulares. */
export type ProfileSectionKind = 'eventos' | 'cursos' | 'podcast';

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
  /** Filtro del podcast; `null` = Todos. */
  const [category, setCategory] = useState<CategoryId | null>(null);
  /** Evento cuya ficha se esta viendo. */
  const [detail, setDetail] = useState<EventItem | null>(null);
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
            { media: 'audio', limit: 60, ...(category ? { category } : {}) },
            profileId,
          ).then((list) => {
            // El episodio 1 es el mas antiguo; el backend devuelve al reves.
            if (alive) setEpisodes([...list].reverse());
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
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [kind, profileId, reloadKey, category]);

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

        {isAdmin ? (
          <Button
            label="Agregar audio"
            variant="secondary"
            icon="plus"
            onPress={() => setCreating(true)}
          />
        ) : null}
        <PodcastList
          episodes={episodes}
          showLockedSlots={category === null}
          onEdit={isAdmin ? (id) => router.push(`/edit-post/${id}` as never) : undefined}
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
            <EventCard
              key={event.id}
              event={event}
              onPress={() => setDetail(event)}
              onEdit={
                isAdmin
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
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.xxl },
  centerText: { textAlign: 'center' },
  list: { marginTop: spacing.md },
  filters: { flexDirection: 'row', gap: spacing.sm, paddingVertical: spacing.sm },
});
