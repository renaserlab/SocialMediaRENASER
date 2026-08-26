import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';

import { CourseCard } from '@/components/CourseCard';
import { CreateCatalogSheet, type CatalogEditable } from '@/components/CreateCatalogSheet';
import { CreateReviewSheet } from '@/components/CreateReviewSheet';
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
import { PostRepository } from '@/repositories/PostRepository';
import {
  ReviewRepository,
  mensajeDeErrorDeResena,
  type Resena,
} from '@/repositories/ReviewRepository';
import { TestimonialRepository } from '@/repositories/TestimonialRepository';
import { irAlPerfil } from '@/lib/irAlPerfil';
import { adminEnCache, pedirDestacados } from '@/services/cachePerfil';
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
  /**
   * Las resenas que ha RECIBIDO este perfil (migracion 0030).
   *
   * NO es lo mismo que `testimonials`, y ahi estaba el fallo: la galeria son
   * las fotos y videos que ha publicado esta persona, filtrados por
   * `author_id`. Es decir, lo que ella ESCRIBIO, nunca lo que le dijeron. Una
   * resena de A sobre B tiene que salir en el perfil de B, y para eso hacia
   * falta una tabla con `reviewed_user_id`, que la galeria no tiene.
   */
  const [resenas, setResenas] = useState<Resena[]>([]);
  /**
   * Si el servidor tiene montado el dominio de resenas.
   *
   * Mientras la 0030 espere aprobacion responde false y no se ensena el boton
   * de escribir. Ofrecerlo y fallar al pulsarlo es la misma pantalla cargando
   * de siempre, solo que con otro motivo.
   */
  const [resenasDisponibles, setResenasDisponibles] = useState(false);
  /** Imagen abierta a pantalla completa, o null si el visor esta cerrado. */
  const [viewerImage, setViewerImage] = useState<{ uri: string; caption: string | null } | null>(
    null,
  );
  /** Filtro de la galeria: 0 todos, 1 fotos, 2 videos. */
  const [testimonialFilter, setTestimonialFilter] = useState(0);
  /**
   * Que reseña en video esta abierta. UNA como mucho: solo esa monta
   * reproductor, el resto son una superficie con su boton.
   */
  const [videoAbierto, setVideoAbierto] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** Elemento en edicion; solo el administrador puede abrirlo. */
  const [editing, setEditing] = useState<CatalogEditable | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  /*
    Quien administra RENASER se averigua ANTES de que nadie toque nada.

    El boton de abajo lleva a la seccion equivalente en su perfil, y el id no
    va escrito: hay que preguntarlo. Antes se preguntaba AL PULSAR, y como esa
    consulta tarda casi un segundo, el boton se quedaba muerto en la mano y la
    pantalla no se movia hasta que respondiera. Preguntandolo al montar —y con
    la respuesta compartida entre las cinco pantallas que la usan— el toque ya
    encuentra el id resuelto y navega en el acto.
  */
  const [adminId, setAdminId] = useState<string | null>(() => adminEnCache());
  useEffect(() => {
    if (adminId) return;
    let vivo = true;
    pedirDestacados()
      .then((lista) => {
        if (!vivo) return;
        setAdminId((lista.find((m) => m.isAdmin) ?? lista[0])?.id ?? null);
      })
      .catch(() => {
        // Sin red no se puede resolver; se puede llegar desde el inicio.
      });
    return () => {
      vivo = false;
    };
  }, [adminId]);

  /**
   * Lleva a la seccion equivalente en el perfil del administrador, que es
   * donde vive el contenido de RENASER.
   *
   * Si el id todavia no llego se espera a el, como se hacia siempre: es
   * preferible una pausa rara a un boton que no hace nada. Pero eso ya solo
   * pasa si se toca en el primer segundo de vida de la pantalla.
   */
  const openAdminSection = useCallback(
    async (target: ProfileSectionKind) => {
      if (adminId) {
        irAlPerfil(router, adminId, target);
        return;
      }
      try {
        const featured = await pedirDestacados();
        const admin = featured.find((m) => m.isAdmin) ?? featured[0];
        if (admin) irAlPerfil(router, admin.id, target);
      } catch {
        // Sin red no se puede resolver; se puede llegar desde el inicio.
      }
    },
    [router, adminId],
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
  /** La hoja de escribir una resena SOBRE el dueno de este perfil. */
  const [escribiendoResena, setEscribiendoResena] = useState(false);
  /** La resena propia que se esta editando, si hay alguna. */
  const [editandoResena, setEditandoResena] = useState<Resena | null>(null);
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
   * Quien esta mirando.
   *
   * Hace falta para distinguir MI resena de una que simplemente puedo moderar:
   * `puedeGestionar` es cierto tambien para la administracion, asi que
   * usarlo para decidir el boton haria que un moderador viera «Editar mi
   * reseña» sobre la opinion de otra persona.
   */
  const miId = useAppStore((state) => state.user?.id ?? null);
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

  /**
   * Las resenas recibidas por este perfil.
   *
   * EFECTO APARTE Y NO DENTRO DEL DE ARRIBA a proposito: aquel se vuelve a
   * lanzar cada vez que se toca el filtro Todos/Fotos/Videos, que es de la
   * galeria y no tiene nada que ver con las resenas. Metidas ahi, cambiar de
   * pestana costaria dos peticiones de mas por toque.
   */
  useEffect(() => {
    if (kind !== 'testimonios' || !profileId || !AuthRepository.enabled) return;
    let alive = true;

    // La disponibilidad se pregunta primero: sin la migracion 0030 el listado
    // viene vacio igualmente, pero es esto lo que decide si se ensena el boton
    // de escribir.
    void ReviewRepository.disponibles().then((hay) => {
      if (alive) setResenasDisponibles(hay);
    });
    ReviewRepository.listarRecibidas(profileId)
      .then((lista) => {
        if (alive) setResenas(lista);
      })
      .catch(() => {
        // Que no se puedan traer las resenas NO puede tumbar la seccion: la
        // galeria de este perfil sigue siendo contenido real y se pinta igual.
        if (alive) setResenas([]);
      });

    return () => {
      alive = false;
    };
  }, [kind, profileId, reloadKey]);

  /**
   * Borra una resena PROPIA.
   *
   * Solo aparece la papelera si `puedeGestionar` viene a true, que el servidor
   * calcula para quien la ESCRIBIO y para quien modera. El dueno del perfil no
   * puede borrar lo que se dice de el: su via es reportarlo. Si pudiera, en
   * cada perfil quedaria solo lo favorable y leerlas no serviria para nada.
   */
  const borrarResena = async (resena: Resena) => {
    const aceptado = await confirm({
      title: 'Eliminar tu reseña',
      message: 'Esta acción no se puede deshacer.',
      confirmLabel: 'Eliminar',
      destructive: true,
    });
    if (!aceptado) return;
    try {
      await ReviewRepository.borrar(resena.id);
      toast('Reseña eliminada');
      reload();
    } catch (fallo) {
      notify('No se pudo eliminar', mensajeDeErrorDeResena(fallo));
    }
  };

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
    //: La resena que YO he escrito sobre este perfil, si ya escribi una.
    const miResena = miId ? resenas.find((r) => r.autorId === miId) ?? null : null;
    return (
      <View>
        {/*
          1. LO QUE HAN ESCRITO SOBRE ESTA PERSONA.

          Esto es lo que faltaba. La galeria de abajo son las fotos y videos que
          esta persona publico —lo que ELLA escribio—, y se conserva tal cual
          porque tiene contenido real. Lo que no existia es esto: una opinion de
          otra persona, que sale AQUI, en el perfil de quien la recibe.

          El boton no aparece en el perfil propio: nadie se resena a si mismo, y
          el servidor lo rechaza ademas por un CHECK en la base.
        */}
        <View style={styles.resenasCabecera}>
          <Text variant="body" weight="700" style={{ flex: 1 }}>
            Reseñas recibidas
          </Text>
          {!isOwner && resenasDisponibles ? (
            <Button
              /*
                Solo se puede escribir UNA por persona (indice unico de la
                0030). Si ya hay una mia, el boton lleva a editarla en vez de a
                escribir otra que el servidor rechazaria con 409.

                Se busca por `autorId === miId`, NO por `puedeGestionar`: eso
                ultimo tambien es cierto para la administracion, y un moderador
                acabaria editando la opinion de otra persona creyendo que era
                la suya.
              */
              label={miResena ? 'Editar mi reseña' : 'Escribir reseña'}
              variant="secondary"
              icon="edit-2"
              onPress={() =>
                miResena ? setEditandoResena(miResena) : setEscribiendoResena(true)
              }
            />
          ) : null}
        </View>

        {resenas.length === 0 ? (
          <View style={styles.center}>
            <Text variant="secondary" color={colors.textMuted} style={styles.centerText}>
              {isOwner
                ? 'Todavía no te ha escrito nadie.'
                : resenasDisponibles
                ? 'Aún no tiene reseñas. Puedes ser la primera persona en escribir una.'
                : 'Aún no tiene reseñas.'}
            </Text>
          </View>
        ) : (
          <View style={styles.resenas}>
            {resenas.map((resena) => (
              <View
                key={resena.id}
                style={[styles.resenaCard, { borderColor: colors.border }]}
              >
                <View style={styles.resenaCabecera}>
                  <ExpoImage
                    source={resena.autorAvatarUrl ? { uri: resena.autorAvatarUrl } : undefined}
                    style={styles.resenaAvatar}
                    contentFit="cover"
                  />
                  <View style={{ flex: 1 }}>
                    <Text variant="body" weight="600">
                      {resena.autorNombre || 'Alguien'}
                    </Text>
                    {/*
                      El sello solo se pinta cuando el servidor manda su FUENTE.
                      No se deduce aqui: el telefono no ve las reservas ni las
                      compras de nadie, asi que cualquier calculo local seria
                      inventado.
                    */}
                    {resena.verificadaPor ? (
                      <View style={styles.selloFila}>
                        <Feather name="check-circle" size={12} color={colors.textMuted} />
                        <Text variant="secondary" color={colors.textMuted} style={styles.sello}>
                          {resena.verificadaPor === 'booking'
                            ? 'Tuvieron una sesión'
                            : 'Compró su curso'}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                  {/*
                    Editar y borrar SOLO si el servidor dice que se puede, que
                    es para quien la escribio y para quien modera. El dueno del
                    perfil NO los ve: no puede quitar lo que se dice de el.
                  */}
                  {resena.puedeGestionar ? (
                    <React.Fragment>
                      <Pressable
                        onPress={() => setEditandoResena(resena)}
                        hitSlop={10}
                        accessibilityRole="button"
                        accessibilityLabel="Editar mi reseña"
                      >
                        <Feather name="edit-2" size={16} color={colors.textMuted} />
                      </Pressable>
                      <Pressable
                        onPress={() => void borrarResena(resena)}
                        hitSlop={10}
                        accessibilityRole="button"
                        accessibilityLabel="Eliminar mi reseña"
                      >
                        <Feather name="trash-2" size={16} color={colors.textMuted} />
                      </Pressable>
                    </React.Fragment>
                  ) : null}
                </View>

                <Text variant="body" style={styles.resenaTexto}>
                  {resena.texto}
                </Text>

                {resena.medios.map((medio) =>
                  !medio.url ? null : medio.tipo === 'video' ? (
                    <VideoPlayer
                      key={medio.id}
                      uri={medio.url}
                      style={styles.resenaMedia}
                      nativeControls
                    />
                  ) : (
                    <Pressable
                      key={medio.id}
                      onPress={() => setViewerImage({ uri: medio.url!, caption: resena.texto })}
                      accessibilityRole="button"
                      accessibilityLabel="Ver la imagen completa"
                    >
                      <ExpoImage
                        source={{ uri: medio.url }}
                        style={styles.resenaMedia}
                        contentFit="cover"
                        transition={150}
                      />
                    </Pressable>
                  ),
                )}
              </View>
            ))}
          </View>
        )}

        {escribiendoResena && profileId ? (
          <CreateReviewSheet
            visible
            sobreId={profileId}
            onClose={() => setEscribiendoResena(false)}
            onSaved={reload}
          />
        ) : null}
        {editandoResena && profileId ? (
          <CreateReviewSheet
            visible
            sobreId={profileId}
            editando={editandoResena}
            onClose={() => setEditandoResena(null)}
            onSaved={reload}
          />
        ) : null}

        {/*
          2. LA GALERIA DE ESTE PERFIL, intacta.

          `testimonials` sigue siendo lo que siempre fue y conserva sus filas.
          Lo unico que cambia es el rotulo: llamarla «reseñas» era lo que hacia
          creer que publicar ahi era opinar sobre alguien.
        */}
        <Text variant="body" weight="700" style={styles.galeriaTitulo}>
          Su galería
        </Text>

        {canManage ? (
          <Button
            label="Añadir a la galería"
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
              Aún no hay nada en la galería.
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
                    /*
                      UN reproductor, el de la reseña que se ha abierto.

                      Antes se montaba uno por cada reseña en video de la lista.
                      Cada reproductor reserva memoria para adelantarse a la
                      reproduccion, asi que un perfil con unas cuantas reseñas
                      agotaba lo que Android concede a la aplicacion; y mientras
                      tanto ninguno estaba reproduciendo, de modo que lo unico
                      que se veia era una hilera de rectangulos oscuros. Es el
                      mismo motivo por el que la cuadricula de publicaciones no
                      monta reproductores.

                      No hay poster que enseñar —la tabla de reseñas no guarda
                      ninguno—, asi que en reposo se pinta la superficie de
                      media con el boton: dice lo que hay y cuesta cero.
                    */
                    videoAbierto === item.id ? (
                      <VideoPlayer
                        uri={item.mediaUrl}
                        style={styles.testimonialMedia}
                        nativeControls
                        autoPlay
                      />
                    ) : (
                      <Pressable
                        onPress={() => setVideoAbierto(item.id)}
                        style={[styles.testimonialMedia, styles.videoEnReposo]}
                        accessibilityRole="button"
                        accessibilityLabel={
                          item.caption ? `Reproducir: ${item.caption}` : 'Reproducir el video'
                        }
                      >
                        <View style={styles.botonDeReproduccion}>
                          <Feather name="play" size={22} color="#FFFFFF" />
                        </View>
                      </Pressable>
                    )
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
                        source={
                          item.mediaUrl
                            ? { uri: item.mediaUrl, cacheKey: item.storagePath }
                            : undefined
                        }
                        style={styles.testimonialMedia}
                        contentFit="cover"
                        /*
                          La clave es la RUTA en Storage, no la firma. Sin ella
                          la galeria se guardaba bajo una URL que caduca cada
                          hora, asi que volver al perfil un rato despues
                          descargaba todas las fotos otra vez.
                        */
                        cachePolicy="disk"
                        recyclingKey={item.storagePath}
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
  // Resenas RECIBIDAS (migracion 0030). Nombres propios y no reutilizando los
  // de `testimonial*`: son dos cosas distintas —lo que le dijeron y lo que
  // publico— y compartir estilos invita a volver a mezclarlas.
  resenasCabecera: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  resenas: { marginTop: spacing.md, gap: spacing.md },
  resenaCard: { borderWidth: 1, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm },
  resenaCabecera: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  resenaAvatar: { width: 34, height: 34, borderRadius: 17 },
  resenaTexto: { lineHeight: 20 },
  resenaMedia: { width: '100%', height: 200, borderRadius: radius.md, overflow: 'hidden' },
  selloFila: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  sello: { fontSize: 11 },
  // Separa la galeria de las resenas: sin este aire las dos listas se leen como
  // una sola, que es exactamente la confusion que habia que deshacer.
  galeriaTitulo: { marginTop: spacing.xl, marginBottom: spacing.sm },
  gallery: { marginTop: spacing.md, gap: spacing.md },
  testimonialCard: { borderWidth: 1, borderRadius: radius.lg, overflow: 'hidden' },
  testimonialMedia: { width: '100%', height: 220 },
  // Superficie de la reseña en video antes de abrirla. Oscura porque es media,
  // pero con el boton bien visible: sin el pareceria un hueco roto.
  videoEnReposo: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#141414' },
  botonDeReproduccion: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
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
