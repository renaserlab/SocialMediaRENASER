import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * Secciones del perfil.
 *
 * Las cuatro primeras se abren desde los accesos circulares. `galeria` NO: son
 * las fotos y videos que ha publicado esta persona (`testimonials`), y vivia
 * empotrada dentro de «Reseñas», que es donde no pertenece — ver la nota de
 * `kind === 'testimonios'`. Se llega a ella desde el menu del perfil.
 */
export type ProfileSectionKind =
  | 'eventos'
  | 'cursos'
  | 'podcast'
  | 'testimonios'
  | 'galeria';

/**
 * Que se dice en cada seccion cuando el perfil no administra la aplicacion.
 * Reunido aqui para que anadir una seccion sea anadir una entrada.
 *
 * `testimonios` YA NO ESTA AQUI, Y ES UN ARREGLO, no un olvido. Estaba, y ese
 * era el fallo: esta tabla se consulta ANTES de pintar nada, asi que en el
 * perfil de cualquier persona que no administre la aplicacion la seccion de
 * reseñas ni siquiera llegaba a renderizarse. Lo que se veia en su lugar:
 *
 *   «Aún no tienes reseñas» — en SEGUNDA PERSONA, en el perfil de OTRO.
 *   «Las reseñas de la comunidad están en el perfil de Darren.»
 *   [Ver reseñas de Z]
 *
 * Es decir: en el perfil de Bruno se leia un mensaje dirigido a Bruno y un
 * boton que llevaba a las reseñas de otra persona. Las reseñas de Bruno —que
 * existen y estan a una peticion— no se pedian nunca.
 *
 * Ninguna otra seccion puede ocupar el sitio de las reseñas de alguien: una
 * reseña habla de ESA persona y no hay catalogo central al que remitir.
 */
const ADMIN_SECTIONS: Partial<
  Record<
    ProfileSectionKind,
    {
      icon: 'headphones' | 'calendar' | 'book' | 'camera';
      title: TranslationKey;
      body: TranslationKey;
      action: TranslationKey;
    }
  >
> = {
  // El nombre propio tampoco va escrito en el texto: quien administra la
  // aplicacion se resuelve en tiempo de ejecucion (`adminId`), asi que un
  // nombre fijo aqui es una promesa que el dia que cambie deja de cumplirse.
  podcast: {
    icon: 'headphones',
    title: 'section.noPodcast',
    body: 'section.noPodcastBody',
    action: 'section.goToPodcast',
  },
  eventos: {
    icon: 'calendar',
    title: 'section.noEvents',
    body: 'section.noEventsBody',
    action: 'section.goToEvents',
  },
  cursos: {
    icon: 'book',
    title: 'section.noCourses',
    body: 'section.noCoursesBody',
    action: 'section.goToCourses',
  },
};

/**
 * SOBRE QUE SECCIONES TIENE SENTIDO SALIR AL CATALOGO DE Z DESDE TU PROPIO PERFIL.
 *
 * `ADMIN_SECTIONS` describe el estado vacio de una seccion. Eso NO es lo mismo
 * que tener un catalogo institucional al que remitir, y confundir las dos cosas
 * ya costo un fallo en reseñas: en el perfil de Bruno se ofrecia «Ver reseñas de
 * Z», que llevaba a las reseñas de otra persona.
 *
 * En CURSOS pasaba lo mismo, y por eso se separa aqui. Tu seccion de cursos
 * habla de LOS TUYOS: ofrecerte ahi una salida al catalogo de otro perfil
 * mezcla «todavia no has publicado nada» con «mira lo que publico Z». Son dos
 * mensajes distintos y el segundo no pertenece a tu perfil — el catalogo de
 * cursos ya se descubre desde Explorar, que es donde se busca contenido ajeno.
 *
 * Podcast y Eventos se quedan: ahi el contenido ES de Z, no tuyo, asi que la
 * salida no compite con nada propio y sigue siendo la unica forma de llegar.
 *
 * Si algun dia un tercer sitio necesita esta distincion, se lee de aqui y no se
 * vuelve a deducir de `ADMIN_SECTIONS`.
 */
const CATALOGO_DE_Z_DESDE_MI_PERFIL: ReadonlySet<ProfileSectionKind> = new Set([
  'podcast',
  'eventos',
]);

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
  /**
   * DUEÑO del perfil que se está viendo. Todo lo que se pide aquí se pide
   * SOBRE él: sus cursos, sus episodios, las reseñas que ha recibido.
   *
   * Se llamaba `profileId`, que no decía de quién: en una pantalla donde
   * conviven dos personas —quien mira y a quién mira— un nombre ambiguo es
   * exactamente lo que hace que una consulta acabe usando la persona
   * equivocada.
   */
  profileOwnerId?: string;
  /**
   * Si el dueño del perfil administra la aplicación. El podcast, los eventos
   * y los cursos son suyos: en un perfil normal no hay nada que enseñar.
   */
  ownerIsAdmin?: boolean;
  /**
   * Si quien MIRA es el DUEÑO de este perfil.
   *
   * NO ES LO MISMO QUE PODER ADMINISTRAR, y confundirlos ya costó un fallo
   * aquí: `canManage` es cierto también para la moderación, así que usarlo
   * para decidir textos en primera persona hacía que un moderador leyera «Aún
   * no tienes reseñas» en el perfil de otra persona.
   *
   * Administrar es un PERMISO; ser dueño es una IDENTIDAD. Los textos, las
   * secciones vacías y quién puede escribir una reseña dependen de la
   * identidad; los botones de moderar, del permiso.
   */
  isOwnProfile?: boolean;
  /**
   * Su nombre. Solo para poder decir a quién se está reseñando en la hoja de
   * escribir: «Sobre Ana. Aparecerá en su perfil con tu nombre.»
   *
   * Sin él, esa frase no salía —el dato nunca llegaba hasta aquí— y la hoja se
   * abría sin decir sobre quién se estaba opinando, que en una pantalla donde
   * conviven dos personas es justo lo que hay que dejar claro.
   */
  profileOwnerName?: string;
};

/**
 * Lo que un perfil tiene dentro: su podcast, sus cursos, sus eventos, las
 * reseñas que ha recibido y su galería.
 *
 * El podcast, los eventos y los cursos de Z viven en el perfil de quien
 * administra la aplicación —resuelto en tiempo de ejecución, ver `adminId`—, y
 * las tarjetas del inicio traen aquí a cualquier usuario.
 */
export function ProfileSection({
  kind,
  profileOwnerId,
  ownerIsAdmin = false,
  isOwnProfile = false,
  profileOwnerName,
}: Props) {
  const { t } = useTranslation();
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
  /**
   * Si ademas se puede decir DE QUE CURSO habla una resena (migracion 0041).
   *
   * Va aparte de `resenasDisponibles` porque son dos migraciones distintas y se
   * aplicaran en momentos distintos: con la 0030 puesta y la 0041 no, se puede
   * escribir una resena pero no enlazarla a un curso.
   */
  const [cursoEnResenaDisponible, setCursoEnResenaDisponible] = useState(false);
  /**
   * Si las resenas todavia estan viajando.
   *
   * Hace falta desde que la galeria dejo de vivir dentro de esta seccion: antes
   * el `loading` general lo marcaba la peticion de la galeria, que se pedia a la
   * vez. Sin esto, la seccion se pintaba vacia durante el viaje y decia «aún no
   * tiene reseñas» a alguien que si las tiene — una lista que todavia no ha
   * llegado no es una lista vacia.
   */
  const [resenasCargando, setResenasCargando] = useState(true);
  /** Imagen abierta a pantalla completa, o null si el visor esta cerrado. */
  const [viewerImage, setViewerImage] = useState<{ uri: string; caption: string | null } | null>(
    null,
  );
  /** Filtro de la galeria: 0 todos, 1 fotos, 2 videos. */
  const [testimonialFilter, setTestimonialFilter] = useState(0);
  /**
   * Que video esta abierto en toda la seccion. UNO como mucho: solo ese monta
   * reproductor, el resto son una superficie con su boton.
   *
   * Lo COMPARTEN las resenas recibidas y la galeria de testimonios a
   * proposito, y no es un descuido: son dos listas de la misma pantalla, asi
   * que con un estado para cada una se podrian tener dos reproductores vivos
   * a la vez. Con uno solo, abrir un video cierra el anterior venga de donde
   * venga, y el techo de reproductores nativos del perfil es uno.
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
   * Se recarga al VOLVER a la pantalla. Sin esto, publicar un episodio (o un
   * evento) desde otra vista no se reflejaba aqui: la lista se habia pedido al
   * montar y no se volvia a pedir, asi que lo recien subido no aparecia.
   *
   * EL PRIMER FOCO SE SALTA A PROPOSITO. `useFocusEffect` tambien dispara al
   * MONTAR, asi que `reloadKey` pasaba de 0 a 1 antes de que llegara la
   * primera respuesta; y como los dos efectos de datos lo llevan en las
   * dependencias, pedian TODO dos veces en cada apertura. La primera tanda se
   * tiraba a la basura (`alive = false`) en cuanto volvia la segunda: dos
   * viajes donde hace falta uno, en podcast, cursos y eventos, y SEIS donde
   * hacen falta tres en testimonios —listado, resenas disponibles y resenas
   * recibidas—. Al montar ya carga el efecto de datos; esto solo tiene que
   * ocuparse de las VUELTAS.
   */
  const yaSeEnfoco = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!yaSeEnfoco.current) {
        yaSeEnfoco.current = true;
        return;
      }
      reload();
    }, [reload]),
  );

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
  const categorias = useCategoriasDePodcast(kind === 'podcast' ? profileOwnerId : null);
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
   * PERMISO para publicar y editar en ESTA seccion: en su propio perfil
   * cualquiera, y quien administra en cualquiera (para moderar).
   *
   * Antes solo mandaba `isAdmin`, de modo que la comunidad no podia compartir
   * sus cursos ni sus resenas. Quien decide de verdad es el servidor: la
   * comprobacion de aqui solo evita ensenar botones que iban a fallar.
   *
   * NO SIRVE PARA SABER DE QUIEN ES EL PERFIL, y ese fue el fallo que se
   * arregla en este trabajo. Es cierto tambien para la moderacion, asi que
   * usarlo para redactar en primera persona hace que un moderador lea «Aún no
   * tienes reseñas» en el perfil de otra persona. Para eso esta
   * `isOwnProfile`, que es una identidad y no un permiso.
   */
  const canManage = isOwnProfile || isAdmin;

  /**
   * Si ESTE curso es de quien mira. Es lo que abre «Gestionar curso».
   *
   * No vale `canManage`: es cierto tambien para la moderacion, y entonces
   * cualquier administrador veria la gestion de los cursos de los demas
   * colgando de su perfil. Aqui la pregunta es de propiedad, no de permiso.
   */
  const esAutorDe = (curso: Course): boolean =>
    curso.authorId ? curso.authorId === miId : isOwnProfile;

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
            profileOwnerId ?? '',
            {
              media: 'audio',
              limit: 60,
              excludeCategory: PRIVATE_AUDIO_CATEGORY,
              ...(category ? { category } : {}),
            },
            profileOwnerId,
          ).then((list) => {
            // El episodio 1 es el mas antiguo; el backend devuelve al reves.
            if (alive) setEpisodes([...list].reverse());
          })
        : kind === 'galeria'
        ? /*
             LA GALERIA SOLO SE PIDE EN LA GALERIA.

             Antes se pedia tambien en `testimonios`, porque la galeria vivia
             empotrada dentro de la seccion de reseñas. Eso eran dos listados
             distintos —lo que esta persona publico y lo que le dijeron— en la
             misma pantalla, mezclados bajo el mismo rotulo, y una peticion de
             mas cada vez que alguien abria las reseñas de alguien.
           */
          TestimonialRepository.list(
            TESTIMONIAL_FILTERS[testimonialFilter] ?? 'all',
            profileOwnerId,
          ).then((list) => {
            if (alive) setTestimonials(list);
          })
        : kind === 'testimonios'
        ? /*
             Las reseñas RECIBIDAS tienen su propio efecto (el de mas abajo):
             este se vuelve a lanzar cada vez que cambia el filtro de la
             galeria, y las reseñas no tienen nada que ver con el.
           */
          Promise.resolve()
        : kind === 'eventos'
        ? CatalogRepository.listEvents().then((page) => {
            if (alive) {
              // Solo los que organiza este perfil.
              setEvents(
                profileOwnerId
                  ? page.items.filter((e) => !e.organizerId || e.organizerId === profileOwnerId)
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
          (isOwnProfile
            ? LearningRepository.listMine()
            : LearningRepository.listCourses()
          ).then((list) => {
            if (alive) {
              setCourses(
                profileOwnerId && !isOwnProfile
                  ? list.filter((c) => !c.authorId || c.authorId === profileOwnerId)
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
    // `isOwnProfile` decide si los cursos se piden del catalogo publico o de los
    // propios (con borradores): sin el en la lista, cambiar de perfil sin
    // desmontar dejaria la decision anterior.
  }, [kind, profileOwnerId, reloadKey, testimonialFilter, category, isOwnProfile]);

  /**
   * Las resenas recibidas por este perfil.
   *
   * EFECTO APARTE Y NO DENTRO DEL DE ARRIBA a proposito: aquel se vuelve a
   * lanzar cada vez que se toca el filtro Todos/Fotos/Videos, que es de la
   * galeria y no tiene nada que ver con las resenas. Metidas ahi, cambiar de
   * pestana costaria dos peticiones de mas por toque.
   */
  useEffect(() => {
    if (kind !== 'testimonios' || !profileOwnerId || !AuthRepository.enabled) return;
    let alive = true;
    setResenasCargando(true);

    // La disponibilidad se pregunta primero: sin la migracion 0030 el listado
    // viene vacio igualmente, pero es esto lo que decide si se ensena el boton
    // de escribir.
    void ReviewRepository.disponibles().then((estado) => {
      if (!alive) return;
      setResenasDisponibles(estado.hay);
      // Y si ademas se puede decir DE QUE CURSO habla (migracion 0041). Sin
      // ella el selector no se ofrece: pedir un dato que se va a tirar sin
      // decirlo es peor que no pedirlo.
      setCursoEnResenaDisponible(estado.conCurso);
    });
    // SIEMPRE con `profileOwnerId`, que es el DUEÑO del perfil. Con quien mira
    // —el error facil en una pantalla donde hay dos personas— la lista traeria
    // las reseñas del visitante y las pintaria en el perfil ajeno.
    ReviewRepository.listarRecibidas(profileOwnerId)
      .then((lista) => {
        if (alive) setResenas(lista);
      })
      .catch(() => {
        // Que no se puedan traer las resenas NO puede tumbar la seccion.
        if (alive) setResenas([]);
      })
      .finally(() => {
        if (alive) setResenasCargando(false);
      });

    return () => {
      alive = false;
    };
  }, [kind, profileOwnerId, reloadKey]);

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
      title: t('review.deleteOwnTitle'),
      message: t('common.cannotBeUndone'),
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (!aceptado) return;
    try {
      await ReviewRepository.borrar(resena.id);
      toast(t('review.deleted'));
      reload();
    } catch (fallo) {
      notify(t('common.deleteFailed'), mensajeDeErrorDeResena(fallo));
    }
  };

  const removeTestimonial = async (id: string) => {
    const accepted = await confirm({
      title: t('review.deleteTitle'),
      message: t('common.cannotBeUndone'),
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (!accepted) return;
    try {
      await TestimonialRepository.remove(id);
      toast(t('review.deleted'));
      reload();
    } catch {
      notify(t('common.deleteFailed'), t('common.tryAgain'));
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
    Lo que hay en esta seccion. Se calcula AQUI ARRIBA y no donde se pinta la
    lista porque el aviso de mas abajo necesita saber si hay algo o no.
  */
  const items = kind === 'eventos' ? events : courses;

  /*
    PERFIL AJENO Y SIN NADA QUE ENSEÑAR.

    Este bloque decia «Aún no TIENES cursos» y ofrecia un boton «Ver cursos de
    Z». Dos cosas mal en la misma pantalla: el texto le hablaba de si mismo a
    quien esta visitando el perfil de OTRA persona, y el boton mandaba al
    catalogo de la comunidad desde un sitio donde nadie lo habia pedido.

    Pero el fallo de verdad no era el texto. La condicion NO MIRABA SI HABIA
    CONTENIDO —le faltaba `items.length === 0`—, asi que en cualquier perfil
    ajeno se entraba aqui y se devolvia el aviso ANTES de llegar a pintar la
    lista. Es decir: los cursos de otra persona no se veian NUNCA, publicara
    los que publicara. El comentario que habia aqui ya decia «cuando aqui no
    hay nada que enseñar»; era la condicion la que no lo comprobaba.

    Se conserva la parte que si era intencionada: en el perfil PROPIO no se
    entra, para que quede sitio al boton de alta, y el acceso al catalogo de Z
    baja al final, debajo de lo tuyo.
  */
  if (
    kind !== 'podcast' &&
    !ownerIsAdmin &&
    !canManage &&
    items.length === 0 &&
    ADMIN_SECTIONS[kind]
  ) {
    return (
      <View style={styles.center}>
        <Feather name={ADMIN_SECTIONS[kind]!.icon} size={30} color={colors.textMuted} />
        <Text variant="body" weight="700" style={styles.centerText}>
          {t(kind === 'cursos' ? 'section.otherNoCourses' : 'section.otherNoEvents', {
            name: profileOwnerName || t('section.someone'),
          })}
        </Text>
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
            label={t('home.addAudio')}
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

  /*
    LA GALERIA DEL PERFIL: las fotos y videos que ha publicado esta persona.

    VIVIA DENTRO DE «RESEÑAS», Y ESE ERA EL FALLO. Debajo de las opiniones que
    otros habian escrito aparecia «Su galería», «Añadir a la galería» y un
    Todos / Fotos / Vídeos: dos listas distintas —lo que le dijeron y lo que
    publico— una detras de otra, bajo el mismo titulo. Es exactamente la
    confusion que ya habia costado que `testimonials` se usara como si fuera una
    tabla de reseñas: quien pulsaba «Añadir a la galería» creyendo opinar sobre
    alguien acababa publicando en SU PROPIO perfil.

    No se esconde cuando esta vacia: se saca de ahi. Esconder lo vacio deja el
    fallo intacto y solo lo hace mas dificil de ver.

    Sigue siendo contenido REAL y con filas de gente real, asi que no se borra:
    tiene su propia seccion, a la que se llega desde el menu del perfil.
  */
  if (kind === 'galeria') {
    return (
      <View>
        <Text variant="body" weight="700" style={styles.galeriaTitulo}>
          {isOwnProfile ? t('gallery.own') : t('gallery.other')}
        </Text>

        {/*
          AÑADIR SOLO EN LA PROPIA, y esto es `isOwnProfile` y no `canManage`
          por una razón que no es de permisos: `CreateTestimonialSheet` publica
          SIEMPRE a nombre de quien escribe (`author_id`), así que pulsarlo en
          el perfil de otra persona añadía la foto a la galería del que pulsa —y
          como esta lista está filtrada por el dueño del perfil, no aparecía por
          ningún lado. El botón prometía algo que no puede hacer.

          Moderar sigue siendo otra cosa: quitar o corregir una pieza ajena se
          decide con `canManage`, ahí abajo, en cada tarjeta.
        */}
        {isOwnProfile ? (
          <Button
            label={t('gallery.add')}
            variant="secondary"
            icon="plus"
            onPress={() => setCreating(true)}
          />
        ) : null}

        <SegmentedControl
          options={[t('gallery.all'), t('gallery.photos'), t('gallery.videos')]}
          selectedIndex={testimonialFilter}
          onChange={setTestimonialFilter}
          style={styles.testimonialFilters}
        />

        {testimonials.length === 0 ? (
          <View style={styles.center}>
            <Text variant="secondary" color={colors.textMuted} style={styles.centerText}>
              {t('gallery.empty')}
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
                          item.caption
                            ? t('gallery.playNamed', { titulo: item.caption })
                            : t('gallery.playVideo')
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
                        item.caption
                          ? t('gallery.viewImageNamed', { titulo: item.caption })
                          : t('gallery.viewImage')
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
                    {item.caption || (item.mediaType === 'video' ? t('video.video') : t('gallery.photo'))}
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
                        accessibilityLabel={t('review.edit')}
                      >
                        <Feather name="edit-2" size={16} color={colors.textMuted} />
                      </Pressable>
                      <Pressable
                        onPress={() => void removeTestimonial(item.id)}
                        hitSlop={10}
                        accessibilityRole="button"
                        accessibilityLabel={t('review.deleteTitle')}
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
        <ImageViewer
          uri={viewerImage?.uri ?? null}
          caption={viewerImage?.caption ?? null}
          onClose={() => setViewerImage(null)}
        />
      </View>
    );
  }

  // Las reseñas que ha RECIBIDO este perfil. Solo eso: la galeria es otra cosa
  // y tiene su propia seccion (ver arriba).
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
            {t('review.received')}
          </Text>
          {!isOwnProfile && resenasDisponibles ? (
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
              label={miResena ? t('review.editMine') : t('review.write')}
              variant="secondary"
              icon="edit-2"
              onPress={() =>
                miResena ? setEditandoResena(miResena) : setEscribiendoResena(true)
              }
            />
          ) : null}
        </View>

        {resenasCargando ? (
          /*
            Todavia viajando. UNA LISTA QUE NO HA LLEGADO NO ES UNA LISTA VACIA,
            y decir «aún no tiene reseñas» mientras se piden es afirmar algo que
            no se sabe — a alguien que quiza tenga veinte.
          */
          <View style={styles.center}>
            <ActivityIndicator color={colors.textMuted} />
          </View>
        ) : resenas.length === 0 ? (
          <View style={styles.center}>
            <Text variant="secondary" color={colors.textMuted} style={styles.centerText}>
              {/*
                QUIEN LEE ESTO DECIDE EL TEXTO, y esa distincion es el arreglo.

                En el perfil de otra persona se hablaba en SEGUNDA PERSONA
                —«Aún no tienes reseñas»—, que es un mensaje dirigido al dueño
                del perfil leido por un visitante. La condicion es
                `isOwnProfile`, una IDENTIDAD, y no `canManage`, que es un
                permiso y tambien es cierto para la moderacion: con aquella, un
                moderador leia el texto del dueño en el perfil de cualquiera.
              */}
              {isOwnProfile
                ? t('review.emptyOwn')
                : resenasDisponibles
                ? t('review.emptyOtherCanWrite')
                : t('review.emptyOther')}
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
                      {resena.autorNombre || t('notif.someone')}
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
                            ? t('review.verifiedBooking')
                            : t('review.verifiedCourse')}
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
                        accessibilityLabel={t('review.editMine')}
                      >
                        <Feather name="edit-2" size={16} color={colors.textMuted} />
                      </Pressable>
                      <Pressable
                        onPress={() => void borrarResena(resena)}
                        hitSlop={10}
                        accessibilityRole="button"
                        accessibilityLabel={t('review.deleteOwnTitle')}
                      >
                        <Feather name="trash-2" size={16} color={colors.textMuted} />
                      </Pressable>
                    </React.Fragment>
                  ) : null}
                </View>

                {/*
                  DE QUE CURSO HABLA, si lo dice (migracion 0041). Va ENCIMA del
                  texto porque es el contexto de lo que se va a leer: «me ayudó
                  muchísimo» no significa lo mismo suelto que bajo el nombre de
                  un programa concreto.

                  El titulo lo resuelve el SERVIDOR y viaja con la resena: sin
                  eso, pintar este rotulo costaria una peticion por tarjeta.
                */}
                {resena.cursoTitulo ? (
                  <View style={[styles.resenaCurso, { borderColor: colors.border }]}>
                    <Feather name="book" size={12} color={colors.textMuted} />
                    <Text
                      variant="secondary"
                      color={colors.textMuted}
                      numberOfLines={1}
                      style={styles.resenaCursoTexto}
                    >
                      {`Sobre el curso · ${resena.cursoTitulo}`}
                    </Text>
                  </View>
                ) : null}

                <Text variant="body" style={styles.resenaTexto}>
                  {resena.texto}
                </Text>

                {resena.medios.map((medio) =>
                  !medio.url ? null : medio.tipo === 'video' ? (
                    /*
                      UN reproductor, el del video que se ha abierto. Misma
                      regla que en los testimonios de aqui abajo y que en la
                      cuadricula, y por el mismo motivo medido: se montaba uno
                      por CADA video de CADA resena, sin condicion. El listado
                      trae hasta veinte resenas, asi que un perfil con resenas
                      en video creaba veinte reproductores nativos de golpe
                      —cada uno reservando memoria por delante— sin que
                      ninguno estuviera reproduciendo. Eso es lo que agota lo
                      que Android concede a la aplicacion y la cierra.

                      La tabla de resenas no guarda poster, asi que en reposo
                      se pinta la superficie de media con su boton: dice que
                      ahi hay un video y cuesta cero.
                    */
                    videoAbierto === medio.id ? (
                      <VideoPlayer
                        key={medio.id}
                        uri={medio.url}
                        style={styles.resenaMedia}
                        nativeControls
                        autoPlay
                      />
                    ) : (
                      <Pressable
                        key={medio.id}
                        onPress={() => setVideoAbierto(medio.id)}
                        style={[styles.resenaMedia, styles.videoEnReposo]}
                        accessibilityRole="button"
                        accessibilityLabel={t('review.playVideo')}
                      >
                        <View style={styles.botonDeReproduccion}>
                          <Feather name="play" size={22} color="#FFFFFF" />
                        </View>
                      </Pressable>
                    )
                  ) : (
                    <Pressable
                      key={medio.id}
                      onPress={() => setViewerImage({ uri: medio.url!, caption: resena.texto })}
                      accessibilityRole="button"
                      accessibilityLabel={t('gallery.viewImage')}
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

        {/*
          La hoja de escribir se monta SOLO en el perfil ajeno, porque solo se
          abre desde ahi: `escribiendoResena` no puede ponerse a cierto en el
          propio —el boton no existe— y el servidor lo rechaza ademas por un
          CHECK en la base (0030). Tres capas para lo mismo, y la que manda es
          la ultima.
        */}
        {escribiendoResena && profileOwnerId ? (
          <CreateReviewSheet
            visible
            sobreId={profileOwnerId}
            sobreNombre={profileOwnerName}
            cursosDisponibles={cursoEnResenaDisponible}
            onClose={() => setEscribiendoResena(false)}
            onSaved={reload}
          />
        ) : null}
        {editandoResena && profileOwnerId ? (
          <CreateReviewSheet
            visible
            sobreId={profileOwnerId}
            sobreNombre={profileOwnerName}
            cursosDisponibles={cursoEnResenaDisponible}
            editando={editandoResena}
            onClose={() => setEditandoResena(null)}
            onSaved={reload}
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

  // Vacio y sin nada que ofrecer: solo entonces se corta aqui. Si se puede
  // crear, se continua para pintar el boton de alta y el acceso al catalogo.
  if (items.length === 0 && !canManage) {
    return (
      <View style={styles.center}>
        <Text variant="secondary" color={colors.textMuted} style={styles.centerText}>
          {kind === 'eventos' ? t('profile.noEvents') : t('profile.noCourses')}
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
            <View key={course.id}>
              <CourseCard
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
                          currency: course.currency,
                          topicIds: course.topicIds,
                        })
                    : undefined
                }
              />
              {/*
                GESTIONAR EL CURSO: quien esta dentro, lo cobrado y lo devuelto.

                SOLO PARA SU AUTOR, y no para `canManage`: ese permiso es cierto
                tambien para la moderacion, y la gestion de un curso —sus
                alumnos, su balance— es de quien lo publica, no de quien modera.
                Cuando el listado no trae `authorId` se cae en `isOwnProfile`,
                que es de donde salen estos cursos (`listMine`).

                Va FUERA de la tarjeta y no dentro: en web cada Pressable es un
                <button>, y la tarjeta ya tiene el suyo cubriendola entera.

                Esconderlo no es el permiso: la pantalla de destino vuelve a
                preguntarle al servidor y dice que no si no es suyo.
              */}
              {esAutorDe(course) ? (
                <Pressable
                  onPress={() => router.push(`/gestionar-curso/${course.id}` as never)}
                  accessibilityRole="button"
                  accessibilityLabel={t(CLAVE_GESTIONAR)}
                  style={styles.gestionar}
                >
                  <Feather name="sliders" size={14} color={colors.text} />
                  <Text variant="secondary" weight="700" color={colors.text}>
                    {t(CLAVE_GESTIONAR)}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ))}

      {/*
        LA PUERTA A «MIS EVENTOS», en la seccion de eventos del propio perfil.
        No se ofrece «crear evento» aqui: un evento ya no se publica al crearlo,
        pasa por admision, y el sitio donde eso se explica es su consola.

        `isOwnProfile` Y NO `canManage`: lo segundo incluye a administracion, y
        un administrador mirando el perfil de otra persona veia un boton «Mis
        eventos» que le llevaba a los SUYOS. Este fichero avisa dos veces de que
        `canManage` no sirve para decisiones de identidad.
      */}
      {kind === 'eventos' && isOwnProfile ? (
        <Button
          label={t('misEventos.titulo')}
          variant="secondary"
          icon="calendar"
          onPress={() => router.push('/mis-eventos' as never)}
        />
      ) : null}

      {/* Alta de un curso nuevo, debajo de los ya publicados. */}
      {kind === 'cursos' && canManage ? (
        <Button
          label={t('home.addCourse')}
          variant="secondary"
          icon="plus"
          onPress={() => setCreating(true)}
        />
      ) : null}

      {/*
        Al final, DOS cosas que antes iban juntas y no son la misma.

        1. El estado vacio de lo TUYO: «todavia no has publicado ningun curso».
           Habla de ti y aparece siempre que tu seccion este vacia.

        2. La salida al catalogo de Z, que solo tiene sentido donde el contenido
           es de Z y no tuyo (ver CATALOGO_DE_Z_DESDE_MI_PERFIL). En cursos
           sobraba: tu seccion habla de los tuyos, y el catalogo se descubre
           desde Explorar.

        Va DEBAJO de lo propio a proposito: en tu perfil lo primero es lo tuyo.
      */}
      {canManage && (items.length === 0 || CATALOGO_DE_Z_DESDE_MI_PERFIL.has(kind)) ? (
        <View style={styles.catalogLink}>
          {items.length === 0 ? (
            <Text variant="secondary" color={colors.textMuted} style={styles.centerText}>
              {kind === 'cursos'
                ? t('section.noneOwnCourses')
                : kind === 'eventos'
                  ? t('section.noneOwnEvents')
                  : ''}
            </Text>
          ) : null}
          {ADMIN_SECTIONS[kind] && CATALOGO_DE_Z_DESDE_MI_PERFIL.has(kind) ? (
            <Button
              label={t(ADMIN_SECTIONS[kind]!.action)}
              variant="secondary"
              icon={ADMIN_SECTIONS[kind]!.icon}
              onPress={() => void openAdminSection(kind)}
            />
          ) : null}
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

/**
 * La clave de «Gestionar curso», que todavia no esta en el diccionario.
 *
 * `t` tipa contra `i18n/es.ts` —lo correcto— y las claves de gestion llegan en
 * este mismo cambio por otro camino: el diccionario no se toca desde aqui. En
 * cuanto este, este alias se borra y la llamada queda igual.
 */
const CLAVE_GESTIONAR = 'section.manageCourse' as TranslationKey;

const styles = StyleSheet.create({
  // «Gestionar curso», debajo de la tarjeta y solo para su autor.
  gestionar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    marginTop: -spacing.sm,
    marginBottom: spacing.md,
  },
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
  // El curso del que habla la resena (0041). Con BORDE e ICONO, no con color:
  // el sistema visual es blanco y negro estricto y el color nunca puede ser el
  // unico portador de informacion.
  resenaCurso: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  resenaCursoTexto: { fontSize: 11, flexShrink: 1 },
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
