import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';

import { CourseCard } from '@/components/CourseCard';
import { CreateCatalogSheet, type CatalogEditable } from '@/components/CreateCatalogSheet';
import { CreateTestimonialSheet, type TestimonialEditable } from '@/components/CreateTestimonialSheet';
import { ImageViewer } from '@/components/ImageViewer';
import { SegmentedControl } from '@/components/SegmentedControl';
import { VideoPlayer } from '@/components/VideoPlayer';
import { Button } from '@/components/Button';
import { EventCard } from '@/components/EventCard';
import { EventDetailSheet } from '@/components/EventDetailSheet';
import { ListRow } from '@/components/ListRow';
import { PodcastList } from '@/components/PodcastList';
import { CategoriasDePodcast } from '@/components/CategoriasDePodcast';
import { useCategoriasDePodcast } from '@/hooks/useCategoriasDePodcast';
import { PRIVATE_AUDIO_CATEGORY } from '@/data/categories';
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
    body: 'Los episodios de Z están en el perfil de Darren.',
    action: 'Ir al podcast de Z',
  },
  eventos: {
    icon: 'calendar',
    title: 'Aún no tienes eventos',
    body: 'Los próximos encuentros de Z están en el perfil de Darren.',
    action: 'Ver eventos de Z',
  },
  cursos: {
    icon: 'book',
    title: 'Aún no tienes cursos',
    body: 'Los programas de Z están en el perfil de Darren.',
    action: 'Ver cursos de Z',
  },
  testimonios: {
    icon: 'camera',
    title: 'Aún no tienes reseñas',
    body: 'Las reseñas de la comunidad están en el perfil de Darren.',
    action: 'Ver reseñas de Z',
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
  /** Imagen abierta a pantalla completa, o null si el visor esta cerrado. */
  const [viewerImage, setViewerImage] = useState<{ uri: string; caption: string | null } | null>(
    null,
  );
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
  /**
   * Filtro del podcast; `null` = Todos.
   *
   * Guarda el ID de una categoría del creador (o una etiqueta antigua, que
   * sigue valiendo porque `posts.category` es texto libre).
   */
  const [category, setCategory] = useState<string | null>(null);
  const categorias = useCategoriasDePodcast(kind === 'podcast' ? profileId : null);
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
        : /*
             En el perfil propio se piden LOS MIOS, que incluyen borradores.

             Con el catalogo publico, un curso recien creado no aparecia por
             ninguna parte —crear ya no publica— y parecia no haberse guardado.
             En el perfil de otra persona se sigue usando el catalogo publico:
             sus borradores son suyos.
           */
          (isOwner
            ? LearningRepository.listMine()
            : LearningRepository.listCourses()
          ).then((list) => {
            if (alive) {
              setCourses(
                profileId && !isOwner
                  ? list.filter((c) => !c.authorId || c.authorId === profileId)
                  : list,
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
    // `isOwner` decide si los cursos se piden del catalogo publico o de los
    // propios (con borradores): sin el en la lista, cambiar de perfil sin
    // desmontar dejaria la decision anterior.
  }, [kind, profileId, reloadKey, testimonialFilter, category, isOwner]);

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

  /*
    Remite al perfil de la administracion cuando aqui no hay nada que enseñar
    NI nada que se pueda crear.

    Antes bastaba con que el perfil no fuera el de la administracion para
    quedarse en este aviso, de modo que en el propio perfil no habia por donde
    publicar un curso: solo el enlace a los de otro. Ahora, si es tu perfil,
    sigue adelante y pinta la seccion con su boton de alta; este acceso baja al
    final, debajo de lo tuyo.
  */
  if (kind !== 'podcast' && !ownerIsAdmin && !canManage && ADMIN_SECTIONS[kind]) {
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
        {/*
          Categorias propias del creador. «Todos» sigue siendo simplemente no
          filtrar, asi que los audios sin categoria —y los que arrastran una
          etiqueta antigua— nunca se quedan sin sitio donde verse.
        */}
        <CategoriasDePodcast
          categorias={categorias.categorias}
          seleccionada={category}
          alSeleccionar={setCategory}
          puedeGestionar={canManage}
          crear={categorias.crear}
          renombrar={categorias.renombrar}
          borrar={categorias.borrar}
        />

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
                    /*
                      En la tarjeta la imagen va recortada para que todas midan
                      igual, y cuando lo compartido es la captura de un texto eso
                      la vuelve ilegible. Al tocarla se abre entera.
                    */
                    <Pressable
                      onPress={() => item.mediaUrl && setViewerImage({
                        uri: item.mediaUrl,
                        caption: item.caption ?? null,
                      })}
                      disabled={!item.mediaUrl}
                      accessibilityRole="button"
                      accessibilityLabel={
                        item.caption ? `Ver la imagen: ${item.caption}` : 'Ver la imagen completa'
                      }
                    >
                      <ExpoImage
                        source={item.mediaUrl ? { uri: item.mediaUrl } : undefined}
                        style={styles.testimonialMedia}
                        contentFit="cover"
                        transition={150}
                      />
                      {/* Pista de que se puede abrir; sin ella nadie lo prueba. */}
                      {item.mediaUrl ? (
                        <View style={[styles.expandBadge, { backgroundColor: colors.overlay }]}>
                          <Feather name="maximize-2" size={13} color="#FFFFFF" />
                        </View>
                      ) : null}
                    </Pressable>
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

        {/*
          Imagen a pantalla completa. Va DENTRO de esta rama porque las resenas
          tienen su propio `return`: montado mas abajo nunca se llegaba a
          renderizar, y tocar la imagen no abria nada.
        */}
        <ImageViewer
          uri={viewerImage?.uri ?? null}
          caption={viewerImage?.caption ?? null}
          onClose={() => setViewerImage(null)}
        />
      </View>
    );
  }

  const items = kind === 'eventos' ? events : courses;
  // Vacio y sin nada que ofrecer: solo entonces se corta aqui. Si se puede
  // crear, se continua para pintar el boton de alta y el acceso al catalogo.
  if (items.length === 0 && !canManage) {
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
                        priceMinor: course.priceMinor,
                        topicIds: course.topicIds,
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

      {/*
        Y al final, el catalogo de Z. Va DEBAJO de lo propio a proposito: en tu
        perfil lo primero es lo tuyo, y esto es una salida hacia el resto, no el
        contenido principal de la pantalla.
      */}
      {canManage && ADMIN_SECTIONS[kind] ? (
        <View style={styles.catalogLink}>
          <Text variant="secondary" color={colors.textMuted} style={styles.centerText}>
            {items.length === 0
              ? `Todavía no has publicado ${kind === 'cursos' ? 'ningún curso' : 'ningún evento'}.`
              : ''}
          </Text>
          <Button
            label={ADMIN_SECTIONS[kind]!.action}
            variant="secondary"
            icon={ADMIN_SECTIONS[kind]!.icon}
            onPress={() => void openAdminSection(kind)}
          />
        </View>
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
  catalogLink: { marginTop: spacing.xl, gap: spacing.sm },
  list: { marginTop: spacing.md },
  // `filters` es de los chips de categoria del podcast. El de la galeria se
  // llama `testimonialFilters` para no pisarlo: ambos se anadieron a la vez.
  testimonialFilters: { marginTop: spacing.md },
  gallery: { marginTop: spacing.md, gap: spacing.md },
  testimonialCard: { borderWidth: 1, borderRadius: radius.lg, overflow: 'hidden' },
  testimonialMedia: { width: '100%', height: 220 },
  expandBadge: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  testimonialFooter: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md },
});
