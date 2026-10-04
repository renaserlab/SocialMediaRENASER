import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { toast } from '@/lib/toast';
import { AccesosAVerticales } from '@/components/AccesosAVerticales';
import { AppHeader } from '@/components/AppHeader';
import { CampoDeBusqueda } from '@/components/CampoDeBusqueda';
import { CoachMark } from '@/components/CoachMark';
import { CreateCatalogSheet, type CatalogKind } from '@/components/CreateCatalogSheet';
import { CursosParaTi } from '@/components/CursosParaTi';
import { espacioParaLaBarra } from '@/components/FloatingGlassTabBar';
import { ListRow } from '@/components/ListRow';
import { MuroDePublicaciones } from '@/components/MuroDePublicaciones';
import { PersonasParaTi } from '@/components/PersonasParaTi';
import type { ProfileSectionKind } from '@/components/ProfileSection';
import { SectionTitle } from '@/components/SectionTitle';
import { SegmentedControl } from '@/components/SegmentedControl';
import { StateView } from '@/components/StateView';
import { StoriesRow } from '@/components/StoriesRow';
import {
  FilaDeResultado,
  filasDeResultados,
  useTextosDeBusqueda,
} from '@/components/resultadosDeBusqueda';
import { assets } from '@/data/assets';
import { useTranslation } from '@/i18n/useTranslation';
import { DARREN_NOTICE_ID } from '@/lib/guides';
import { AuthRepository } from '@/repositories/AuthRepository';
import { useAuthStore } from '@/store/useAuthStore';
import { CatalogRepository } from '@/repositories/CatalogRepository';
import { CommunityRepository, type CircleDetail } from '@/repositories/CommunityRepository';
import { LearningRepository } from '@/repositories/LearningRepository';
import { NotificationRepository } from '@/repositories/NotificationRepository';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Course, EventItem } from '@/types';
import { irAlPerfil } from '@/lib/irAlPerfil';
import { pedirDestacados } from '@/services/cachePerfil';
import { SearchRepository } from '@/repositories/SearchRepository';
import {
  ampliar,
  anotarTecleo,
  aplicar,
  debeDecirSinResultados,
  esBuscable,
  estadoInicial,
  estaOcupado,
  ESPERA_DE_TECLEO_MS,
  lanzar,
  marcarFallo,
  normalizarTermino,
  type EstadoDeBusqueda,
  type Grupo,
} from '@/lib/busquedaProgresiva';

/**
 * Explorar: buscar personas y descubrir todo lo que publica la comunidad.
 *
 * QUE CAMBIA. El muro de publicaciones que vivia en Inicio se muda aqui entero
 * —historias, publicaciones, circulo, podcast, testimonios—, porque Inicio pasa
 * a ser el feed vertical de video. No hay dos implementaciones del muro: es el
 * mismo componente (`MuroDePublicaciones`), con la misma lista virtualizada,
 * los mismos reproductores y la misma paginacion.
 *
 * La fila "Shorts de la comunidad" desaparece de aqui: ya no es un rincon al
 * que entrar, es la pantalla de Inicio.
 *
 * El orden responde a como se usa la pantalla: primero BUSCAR (a lo que se
 * viene con una intencion concreta), luego DESCUBRIR (lo que publica la gente)
 * y al final el CATALOGO —tu siguiente paso, eventos, comunidades—, que es
 * contenido curado y no cambia cada minuto.
 */
export function ExploreScreen() {
  const { colors, mode } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const user = useAppStore((state) => state.user);
  const firstName = user?.fullName?.trim().split(' ')[0];
  const loadFeed = useAppStore((state) => state.loadFeed);

  // Destacados reales del catalogo. Antes el curso, los eventos y el circulo
  // eran los del paquete de demo, con "423 miembros" escrito a mano.
  const [featuredCourse, setFeaturedCourse] = useState<Course | null>(null);
  const [nextEvents, setNextEvents] = useState<EventItem[]>([]);
  const [featuredCircle, setFeaturedCircle] = useState<CircleDetail | null>(null);
  /**
   * Perfil del administrador. Darren gestiona la aplicacion, asi que los
   * eventos y los cursos viven en su perfil: las tarjetas llevan alli a
   * cualquier usuario, a la seccion que haya elegido.
   */
  const [adminId, setAdminId] = useState<string | null>(null);
  /*
    Que el servidor falle y que todavia no haya contenido NO son lo mismo.

    Antes los `.catch` se limitaban a dejar el estado a vacio, asi que una API
    caida se leia en pantalla como «Muy pronto habra contenido disponible»: una
    aplicacion rota parecia una aplicacion a medio llenar. Nadie reintentaba
    porque nada indicaba que hubiera fallado algo.
  */
  const [catalogoFallido, setCatalogoFallido] = useState(false);

  const cargarDestacados = useCallback(async () => {
    if (!AuthRepository.enabled) return;
    const [cursos, eventos, circulos, destacados] = await Promise.allSettled([
      // UNO. Esta tarjeta enseña `cursos.value[0]` y nada más; traer el
      // catálogo entero para quedarse con el primero es pagar por tirar.
      LearningRepository.listCourses(1),
      /*
        SOLO LOS VIGENTES, y lo decide el servidor.

        Esta sección se titula «Próximos eventos» y enseña los dos primeros.
        Como el listado venía ordenado por fecha ascendente SIN filtrar, los dos
        primeros eran casi siempre los más antiguos: en la captura salían
        «Alquimia para crear riqueza · Quito» y «ALQUIMIA · 19 ago. · Lima»,
        uno de ellos ya celebrado, presentados como la próxima oportunidad.

        Se pide el grupo al servidor en lugar de recortar aquí lo descargado:
        con un recorte en el móvil, un catálogo con veinte eventos pasados y uno
        futuro dejaría la sección vacía aunque el evento futuro exista.
      */
      // DOS, que son los que se pintan. Medido: con la agenda llena, pedir
      // cincuenta cuesta 39 KB para rellenar dos filas.
      CatalogRepository.listEvents('upcoming', 2),
      CommunityRepository.list(),
      pedirDestacados(),
    ]);

    if (cursos.status === 'fulfilled') setFeaturedCourse(cursos.value[0] ?? null);
    if (eventos.status === 'fulfilled') setNextEvents(eventos.value.items);
    if (circulos.status === 'fulfilled') setFeaturedCircle(circulos.value[0] ?? null);
    if (destacados.status === 'fulfilled') {
      setAdminId((destacados.value.find((m) => m.isAdmin) ?? destacados.value[0])?.id ?? null);
    }

    const fallos = [cursos, eventos, circulos].filter((r) => r.status === 'rejected');
    // Se avisa solo si fallo TODO. Que una de las secciones no cargue no
    // justifica tapar la pantalla entera con un error.
    setCatalogoFallido(fallos.length === 3);
    for (const fallo of fallos) {
      console.warn('[explorar] no se pudo cargar una seccion', (fallo as PromiseRejectedResult).reason);
    }
  }, []);

  useEffect(() => {
    /*
      SIN ESPERA. Aqui habia un `setTimeout` de 600 ms, y su motivo estaba bien
      escrito: el catalogo es secundario y no debia competir con el muro «por la
      misma conexion y por un servidor recien despierto».

      La mitad de ese motivo ya no existe. No hay servidor recien despierto
      desde que la API vive en AWS, y `/catalog/events` responde en 0,392 s
      medidos contra produccion.

      Lo que si quedaba era el precio: 600 ms de espera mas 0,392 s de peticion
      es UN SEGUNDO largo en el que las tres tarjetas —programa, eventos y
      circulo— enseñan texto de relleno («Muy pronto habra contenido
      disponible») y despues cambian de golpe. Y eso no es un esqueleto que se
      rellena: es contenido equivocado que se sustituye, que es justo lo que se
      siente como una pantalla lenta aunque el servidor haya contestado rapido.

      Las cuatro peticiones son pequeñas, van en paralelo entre si y comparten
      conexion multiplexada con la del muro, que ademas pinta su primera fase
      sin esperar a Storage.
    */
    void cargarDestacados();
  }, [cargarDestacados]);

  /**
   * Solo el administrador ve el acceso para publicar. El permiso de verdad lo
   * aplica el backend (`require_admin`); esto es comodidad, no seguridad.
   */
  const isAdmin = user?.isAdmin === true;
  const [creating, setCreating] = useState<CatalogKind | null>(null);

  /**
   * Perfil donde viven eventos y cursos. Si el propio usuario es el
   * administrador, es SU perfil: el endpoint de destacados excluye a quien
   * mira, asi que no aparece en su propia lista.
   */
  const catalogProfileId = isAdmin ? (user?.id ?? null) : adminId;
  // `useCallback` no es cosmético aquí: esta función entra en las dependencias
  // de la cabecera memorizada, y recrearla en cada render la haría inútil.
  const openAdminSection = useCallback(
    (section: ProfileSectionKind) => {
      if (!catalogProfileId) return;
      irAlPerfil(router, catalogProfileId, section);
    },
    [router, catalogProfileId],
  );

  /**
   * El aviso de contenido gratuito de Darren vive en Notificaciones. Aqui solo
   * se consulta si sigue pendiente para pintar el punto en la campana; no tiene
   * sentido para el propio Darren.
   */
  const darrenNoticePending = useAppStore(
    (state) => !state.dismissedGuides.includes(DARREN_NOTICE_ID) && state.user?.isAdmin !== true,
  );

  /*
    EL PUNTO DE LA CAMPANA TAMBIEN SE ENCIENDE CON LA ACTIVIDAD REAL.

    Hasta ahora solo lo encendia el aviso promocional de Darren, que es un texto
    fijo de la propia aplicacion. O sea: alguien te empezaba a seguir, te
    comentaba o te pedia una sesion, y dentro de la aplicacion no cambiaba nada
    —el aviso existia en la bandeja, pero nada invitaba a abrirla—. El unico
    aviso «dentro de la app» era el banner del push, que no llega en Expo Go, no
    llega sin permiso del sistema y no llega si el aviso se creo mientras la
    persona estaba mirando otra pantalla.

    `unreadCount` ya existia en el repositorio y no lo llamaba nadie. Es UNA
    consulta de conteo, no la bandeja entera.

    Se relee AL VOLVER a esta pantalla porque abrir Notificaciones las marca
    todas como leidas: sin eso, el punto seguiria encendido al volver.
  */
  const estadoDeSesion = useAuthStore((state) => state.status);
  const [avisosSinLeer, setAvisosSinLeer] = useState(0);
  const contarAvisos = useCallback(() => {
    if (!AuthRepository.enabled) return;
    /*
      SIN SESION NO SE PREGUNTA. Un visitante no tiene avisos que contar, asi
      que el servidor solo puede responder 401. Se preguntaba igual: el fallo
      se tragaba en el `catch` y el punto se quedaba apagado —el resultado
      correcto— pero cada entrada en Explorar dejaba un error rojo en la consola
      del navegador, indistinguible de uno de verdad.
    */
    if (estadoDeSesion !== 'authenticated') {
      setAvisosSinLeer(0);
      return;
    }
    NotificationRepository.unreadCount()
      .then(setAvisosSinLeer)
      // Un contador que no se puede leer no es un error que mostrar: en el peor
      // caso el punto no se enciende y la campana sigue estando donde estaba.
      .catch(() => setAvisosSinLeer(0));
  }, [estadoDeSesion]);
  useFocusEffect(contarAvisos);

  // Antes el indice se guardaba pero no se usaba: ambas pestañas mostraban el
  // mismo feed global. Ahora "Siguiendo" pide al backend solo lo de los
  // perfiles que sigue el usuario.
  const [feedTab, setFeedTab] = useState(0);
  const changeTab = useCallback(
    (index: number) => {
      setFeedTab(index);
      void loadFeed(index === 1 ? 'following' : 'all');
    },
    [loadFeed],
  );

  /* ---------------------------------------------------------- Busqueda ---- */
  /*
    ESTE BUSCADOR ENCUENTRA DE TODO, no solo personas. Es el arreglo de la queja
    y conviene dejar escrito por que, porque el fallo no estaba donde parecia.

    Alguien publico un curso, otra persona escribio palabras del tema y la
    pantalla le contesto «Sin resultados — No encontramos personas con ese
    nombre». No era que el curso no se encontrara: el backend lo devolvia
    perfectamente. Es que este buscador preguntaba a `/profiles/search`, que
    solo sabe de PERSONAS, y su estado vacio hablaba de nombres.

    La busqueda global (`GET /api/v1/search`) ya existia, entera y probada, con
    personas, etiquetas, publicaciones, CURSOS, eventos y deteccion de temas
    —«muebles» encuentra carpinteria—. Vivia en `SearchScreen` y era
    INALCANZABLE: el unico enlace a `/search` en toda la aplicacion estaba en
    `app/dev.tsx`, la galeria interna de pantallas. Nadie de fuera la ha abierto
    nunca.

    Asi que este buscador —el que esta fijo arriba de Explorar, el que la gente
    usa de verdad— pasa a preguntar a la busqueda global. No se «lleva» a nadie
    a otra pantalla: se enseña donde ya estaba mirando.

    LA CARRERA DE RESPUESTAS la resuelve `lib/busquedaProgresiva.ts` con un
    sello por peticion, igual que en `SearchScreen`: la respuesta lenta de
    «carp» no puede pisar a la de «carpinteria». Y COMO SE PINTA cada resultado
    vive en `components/resultadosDeBusqueda.tsx`, compartido con esa pantalla,
    para que no vuelva a haber dos buscadores que se separan.

    NO SE EXIGE SESION: el endpoint busca en lo publico sin token, igual que el
    muro se lee sin cuenta desde la 0018. Por eso ya no se mira
    `supabaseEnabled` aqui; si la API no contesta, se dice que no se pudo
    buscar y se ofrece reintentar, que es lo que habia antes para el mismo caso.
  */
  const [query, setQuery] = useState('');
  /** Solo para pintar el foco del campo. No entra en la búsqueda. */
  const [estado, setEstado] = useState<EstadoDeBusqueda>(estadoInicial);

  /*
    El estado tambien en una referencia: lanzar una peticion necesita el sello
    que sale de la misma transicion que actualiza el estado, y los actualizadores
    de `useState` tienen que ser puros. Mismo motivo, y misma forma, que en
    `SearchScreen`.
  */
  const refEstado = useRef(estado);
  const cambiar = useCallback((paso: (previo: EstadoDeBusqueda) => EstadoDeBusqueda) => {
    const siguiente = paso(refEstado.current);
    if (siguiente === refEstado.current) return;
    refEstado.current = siguiente;
    setEstado(siguiente);
  }, []);

  /** Lanza la busqueda del texto que haya escrito ahora mismo. */
  const buscar = useCallback(
    (texto: string, signal?: AbortSignal) => {
      const { estado: enVuelo, sello } = lanzar(refEstado.current, texto);
      refEstado.current = enVuelo;
      setEstado(enVuelo);
      SearchRepository.buscar(texto, { signal })
        .then((respuesta) => cambiar((previo) => aplicar(previo, sello, respuesta)))
        .catch((error) => {
          // Cancelar no es fallar: el aviso seria de una busqueda que ya nadie
          // espera. Y «no hay resultados» cuando en realidad no se pudo
          // preguntar hace creer que lo buscado no existe en la aplicacion.
          if (signal?.aborted) return;
          console.warn('[explorar] la busqueda fallo', error);
          cambiar((previo) => marcarFallo(previo, sello));
        });
    },
    [cambiar],
  );

  useEffect(() => {
    cambiar((previo) => anotarTecleo(previo, query));
    const texto = normalizarTermino(query);
    if (!esBuscable(texto)) return;

    const control = new AbortController();
    const temporizador = setTimeout(() => buscar(texto, control.signal), ESPERA_DE_TECLEO_MS);
    return () => {
      clearTimeout(temporizador);
      control.abort();
    };
  }, [query, cambiar, buscar]);

  /** Pide la pagina siguiente de UN grupo, sin tocar los demas. */
  const verMas = useCallback(
    (grupo: Grupo) => {
      const paso = ampliar(refEstado.current, grupo);
      if (!paso) return;
      refEstado.current = paso.estado;
      setEstado(paso.estado);
      SearchRepository.buscar(paso.sello.termino, { grupo, salto: paso.sello.salto })
        .then((respuesta) => cambiar((previo) => aplicar(previo, paso.sello, respuesta)))
        .catch(() => cambiar((previo) => marcarFallo(previo, paso.sello)));
    },
    [cambiar],
  );

  const isSearching = esBuscable(estado.tecleado);
  const textosDeBusqueda = useTextosDeBusqueda();
  const filasDeBusqueda = useMemo(
    () =>
      filasDeResultados(estado.resultados, {
        ampliando: estado.ampliando,
        verMas,
        textos: textosDeBusqueda,
      }),
    [estado.resultados, estado.ampliando, verMas, textosDeBusqueda],
  );

  /* --------------------------------------------------------- Contenido ---- */

  /*
    LA CABECERA Y EL PIE SE MEMORIZAN, y es un problema medible, no una manía.

    `query` cambia con CADA TECLA. Sin memorizar, cada pulsación reconstruía los
    dos árboles enteros y volvía a renderizar `StoriesRow`, `SegmentedControl`,
    `CursosParaTi` y `PersonasParaTi` —dos carruseles con sus listas— además de
    la tarjeta del programa, la de eventos y la del círculo. Escribir
    «carpinteria» son once reconstrucciones completas de una pantalla que
    encima está TAPADA: los resultados se pintan encima del muro, así que nada
    de eso se ve mientras se escribe.

    Ninguna de esas piezas depende del texto buscado, así que con las
    dependencias declaradas abajo escribir deja de tocarlas. Por eso `changeTab`
    y `openAdminSection` llevan `useCallback`: una función recreada en cada
    render dejaría estas listas siempre distintas y el `useMemo` no serviría de
    nada.
  */
  const cabecera = useMemo(
    () => (
    <View>
      {/* Historias reales del backend (subida + anillo visto/sin ver) */}
      <StoriesRow />

      <View style={styles.container}>
        <SegmentedControl
          options={[t('home.forYou'), t('home.following')]}
          selectedIndex={feedTab}
          onChange={changeTab}
          style={styles.tabs}
        />

        <Pressable
          onPress={() => router.navigate('/(tabs)/create')}
          style={[styles.composer, { backgroundColor: colors.surface, borderColor: colors.border }]}
          accessibilityLabel={t('explore.newPost')}
          accessibilityRole="button"
        >
          {/* Tu foto real; el marcador solo mientras no haya perfil cargado. */}
          <ExpoImage
            source={user?.avatarUrl ? { uri: user.avatarUrl } : assets.avatar}
            style={styles.composerAvatar}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={120}
          />
          <Text style={[styles.composerText, { color: colors.textMuted }]}>
            {/* Sin nombre se saluda en generico: antes caia a un "Katherine"
                fijo del demo y se le mostraba a cualquier usuario. */}
            {firstName ? t('home.composerNamed', { name: firstName }) : t('home.composer')}
          </Text>
          <Feather name="plus-circle" size={24} color={colors.text} />
        </Pressable>

        {/*
          Guia de la primera publicacion. Solo para quien todavia no ha
          publicado: `createPost` sube el contador, asi que se apaga sola en
          cuanto el usuario hace lo que se le pide.
        */}
        <CoachMark
          id="primera-publicacion"
          arrow="up"
          visible={!!user && user.posts === 0}
          text={t('explore.firstPostHint')}
          onPress={() => router.navigate('/(tabs)/create')}
        />

        {/* Tu circulo, junto al acceso al podcast. */}
        <View style={styles.quickRow}>
          <Pressable
            onPress={() => featuredCircle && router.push(`/circle/${featuredCircle.id}` as never)}
            disabled={!featuredCircle}
            style={[
              styles.quickCard,
              { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 },
            ]}
            accessibilityRole="button"
            accessibilityLabel={t('home.yourCircle')}
          >
            <Feather name="users" size={24} color={colors.text} />
            <Text style={[styles.quickTitle, { color: colors.text }]}>{t('home.yourCircle')}</Text>
            {/* Contador real; antes era "423 personas" escrito a mano. */}
            <Text style={[styles.quickBody, { color: colors.textMuted }]}>
              {featuredCircle
                ? t('home.circleMembers', { count: featuredCircle.members })
                : t('home.joinCommunity')}
            </Text>
          </Pressable>

          <View
            style={[
              styles.quickCard,
              { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 },
            ]}
          >
            {/* Igual que en Eventos: la zona pulsable va detras para no anidar
                un <button> dentro de otro en web. */}
            <Pressable
              onPress={() => openAdminSection('podcast')}
              disabled={!catalogProfileId}
              style={StyleSheet.absoluteFill}
              accessibilityRole="button"
              accessibilityLabel={t('home.podcast')}
            />
            <View style={styles.quickHeader} pointerEvents="box-none">
              <View pointerEvents="none">
                <Feather name="headphones" size={24} color={colors.text} />
              </View>
              {isAdmin ? (
                <Pressable
                  onPress={() => setCreating('podcast')}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={t('home.addAudio')}
                  style={[styles.addBadge, { backgroundColor: colors.text }]}
                >
                  <Feather name="plus" size={14} color={colors.background} />
                </Pressable>
              ) : null}
            </View>
            <Text style={[styles.quickTitle, { color: colors.text }]} pointerEvents="none">
              {t('home.podcast')}
            </Text>
            {isAdmin ? (
              <Pressable
                onPress={() => setCreating('podcast')}
                style={[styles.addChip, { borderColor: colors.border }]}
                accessibilityRole="button"
                accessibilityLabel={t('home.addAudio')}
              >
                <Text style={[styles.addChipText, { color: colors.text }]}>{t('home.addAudio')}</Text>
              </Pressable>
            ) : (
              <Text style={[styles.quickBody, { color: colors.textMuted }]} pointerEvents="none">
                {t('home.podcastBody')}
              </Text>
            )}
          </View>
        </View>

        {/* Acceso a la galeria de testimonios, debajo de las tarjetas. */}
        <Pressable
          onPress={() => openAdminSection('testimonios')}
          // Sin perfil al que ir no hace nada: se apaga, como la de Podcast.
          disabled={!catalogProfileId}
          accessibilityRole="button"
          accessibilityLabel={t('home.seeMore')}
          hitSlop={6}
          style={({ pressed }) => [
            styles.seeMore,
            { borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Text style={[styles.seeMoreText, { color: colors.text }]}>{t('home.seeMore')}</Text>
          <Feather name="chevron-right" size={15} color={colors.text} />
        </Pressable>
      </View>

      {/*
        «Cursos para ti» va en la CABECERA, es decir por encima del muro, y no
        abajo con «Personas para ti». En esta iteracion un curso pesa mas que
        una publicacion: es lo que alguien viene a buscar cuando quiere
        aprender algo, y dejarlo debajo del muro lo convertia en algo que solo
        encontraba quien bajaba mucho.

        Fuera del padding lateral a proposito: es un carrusel y tiene que poder
        llegar al borde de la pantalla.

        No hace falta reservarle sitio: si no hay cursos que recomendar, si la
        personalizacion esta apagada o si la peticion falla, la seccion no se
        pinta y la cabecera queda exactamente como estaba.
      */}
      <CursosParaTi />
    </View>
    ),
    [
      t,
      colors,
      router,
      user,
      firstName,
      feedTab,
      changeTab,
      featuredCircle,
      catalogProfileId,
      openAdminSection,
      isAdmin,
    ],
  );

  const pie = useMemo(
    () => (
    <View>
      {/*
        «Personas para ti» va ANTES del catalogo y fuera del padding lateral:
        es un carrusel y tiene que poder llegar al borde de la pantalla.

        Va aqui, en Explorar, y no en una pantalla nueva: es donde ya se viene a
        buscar gente —el buscador de personas esta arriba— y donde tiene sentido
        encontrarse con quien puede aportarte algo. Si no hay a quien recomendar
        (o falla), la seccion no se pinta y el resto de Explorar sigue igual.

        Queda POR DEBAJO de «Cursos para ti», que vive en la cabecera: en esta
        iteracion lo que se puede aprender manda sobre a quien se puede conocer.
      */}
      <PersonasParaTi />

      <View style={styles.container}>
      {/*
        Un fallo del servidor se dice, no se disfraza de «todavia no hay nada».
        Lleva icono y texto ademas del color, y ofrece la salida (reintentar) en
        el mismo sitio donde se ve el problema.
      */}
      {catalogoFallido ? (
        <View style={styles.avisoCarga}>
          <StateView
            state="error"
            icon="wifi-off"
            title={t('common.loadFailed')}
            description={t('common.checkConnection')}
            onRetry={() => void cargarDestacados()}
          />
        </View>
      ) : null}

      <SectionTitle title={t('explore.nextStep')} />
      {/*
        Guia hacia el contenido: sin ella la portada se lee como una imagen
        decorativa y no como algo en lo que se puede entrar. Solo aparece si hay
        un curso real que abrir.
      */}
      <CoachMark
        id="explorar-programa"
        arrow="down"
        visible={!!featuredCourse}
        text={t('explore.programHint')}
        onPress={() => featuredCourse && router.push(`/course/${featuredCourse.id}` as never)}
      />
      <Pressable
        onPress={() => featuredCourse && router.push(`/course/${featuredCourse.id}` as never)}
        disabled={!featuredCourse}
        style={styles.heroCard}
        accessibilityLabel={t('explore.recommendedProgramA11y', {
          titulo: featuredCourse?.title ?? '',
        })}
        accessibilityRole="button"
      >
        <Image source={assets.course} style={StyleSheet.absoluteFill} resizeMode="cover" />
        <View style={[styles.heroOverlay, { backgroundColor: colors.overlay }]} />
        <View style={styles.heroContent}>
          <Text style={styles.eyebrow}>{t('explore.recommendedProgram')}</Text>
          <Text style={styles.heroTitle} numberOfLines={2}>
            {featuredCourse?.title ?? t('explore.programsComing')}
          </Text>
          <Text style={styles.heroBody}>
            {featuredCourse
              ? featuredCourse.subtitle
              : catalogoFallido
              ? t('explore.programLoadFailed')
              : t('explore.contentSoon')}
          </Text>
        </View>
      </Pressable>

      <SectionTitle
        title={t('events.upcoming')}
        action={t('explore.seeCalendar')}
        onActionPress={() => router.push('/events')}
      />
      <View style={styles.list}>
        {nextEvents.length === 0 ? (
          /*
            Sin eventos vigentes se dice, en lugar de dejar un hueco bajo el
            título. El enlace «Ver calendario» de arriba sigue llevando a la
            agenda, donde están los anteriores: no se pierde nada.
          */
          <Text style={[styles.listaVacia, { color: colors.textMuted }]}>
            {catalogoFallido ? t('common.checkConnection') : t('events.emptyBody')}
          </Text>
        ) : (
          nextEvents.slice(0, 2).map((event) => (
            <ListRow
              key={event.id}
              title={event.title}
              subtitle={`${event.date} • ${event.location}`}
              leftComponent={
                /* La portada real del evento; el asset local solo si no tiene. */
                <Image
                  source={event.coverUrl ? { uri: event.coverUrl } : assets.event}
                  style={styles.eventImage}
                />
              }
              rightIcon="chevron-right"
              /* A SU ficha, no al listado: tocar un evento concreto abría la
                 lista entera, donde ese evento era una fila más. */
              onPress={() => router.push(`/eventos/${event.id}` as never)}
            />
          ))
        )}
      </View>

      <SectionTitle title={t('explore.communities')} />
      <Pressable
        onPress={() => featuredCircle && router.push(`/circle/${featuredCircle.id}` as never)}
        disabled={!featuredCircle}
        style={[styles.circle, { backgroundColor: colors.primary }]}
        accessibilityLabel={t('explore.circleA11y', { nombre: featuredCircle?.name ?? '' })}
        accessibilityRole="button"
      >
        <View style={{ flex: 1 }}>
          <Text style={[styles.eyebrow, { color: colors.onPrimary }]}>
            {t('explore.privateCircle')}
          </Text>
          <Text style={[styles.circleTitle, { color: colors.onPrimary }]}>
            {featuredCircle?.name ?? t('profile.circles')}
          </Text>
          <Text style={[styles.circleBody, { color: colors.onPrimary }]}>
            {featuredCircle
              ? t('explore.circleMembers', { count: featuredCircle.members })
              : catalogoFallido
              ? t('explore.circlesLoadFailed')
              : t('explore.circleSoon')}
          </Text>
        </View>
        <Feather name="users" size={48} color={colors.onPrimary} style={styles.circleIcon} />
      </Pressable>
      </View>
    </View>
    ),
    [
      t,
      colors,
      router,
      catalogoFallido,
      cargarDestacados,
      featuredCourse,
      nextEvents,
      featuredCircle,
    ],
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title={t('explore.headerTitle')}
        rightIcon="bell"
        // Un aviso que nadie abre no sirve de nada: el punto marca que el de
        // "contenido de Darren gratis" sigue esperando dentro.
        // El punto se enciende por lo que hay sin ver DETRAS: la actividad
        // real sobre esta persona, o el aviso de contenido gratuito que
        // sigue esperando dentro.
        rightBadge={avisosSinLeer > 0 || darrenNoticePending}
        onRightPress={() => router.push('/notifications')}
      />

      {/*
        El buscador va FIJO, fuera de la lista. Dentro se iba con el
        desplazamiento y buscar a alguien obligaba a subir hasta arriba del
        todo; ahora es el primer elemento de la pantalla y siempre esta ahi.
      */}
      <View style={[styles.container, styles.buscador]}>
        {/*
          EL CAMPO, POR DENTRO.

          Antes era el `Input` genérico de los formularios —rectángulo de radio
          pequeño y borde a todo su alrededor— con la lupa encima, colocada en
          términos absolutos sobre un relleno izquierdo de 30 puntos. Se veía
          como lo que era: un campo de formulario reutilizado, con el icono
          pegado por fuera.

          Se pinta aquí y no se cambia `Input`: ese componente lo comparten
          todos los formularios de la aplicación y un campo de búsqueda no tiene
          por qué arrastrarlos a su forma. La LÓGICA de búsqueda no se toca —el
          mismo `query`, el mismo `setQuery`, el mismo antirrebote—: esto es
          solo cómo se ve.

          Cápsula rellena en lugar de caja con borde: el relleno la separa del
          fondo sin dibujar una línea dura, y el foco se marca engrosando el
          contraste del borde, no con color —el sistema es blanco y negro y
          tiene que leerse igual en los dos temas—.
        */}
        <CampoDeBusqueda
          /*
            El texto de ayuda decia «Buscar personas...», y no era un detalle
            de redaccion: describia exactamente lo que el buscador sabia hacer.
            Quien queria un curso leia eso y buscaba igualmente, porque es el
            unico buscador que hay.
          */
          placeholder={t('search.placeholder')}
          value={query}
          onChangeText={setQuery}
          // La lupa se convierte en un indicador mientras la pregunta esta en
          // vuelo: se ve que salio aunque los resultados de antes sigan ahi.
          buscando={isSearching && estaOcupado(estado)}
          etiquetaDeLimpiar={t('search.clear')}
          style={styles.campoDeBusqueda}
        />
      </View>

      {/*
        Los cuatro accesos de la referencia. Van AQUI, entre el buscador y el
        muro, y no dentro de la cabecera de la lista: la cabecera se desplaza
        con el muro, y un acceso que se va de la pantalla al bajar deja de ser
        un acceso.
      */}
      <AccesosAVerticales
        alTocarNoDisponible={(nombre) =>
          toast(t('verticales.aunNoDisponible').replace('{vertical}', nombre))
        }
      />

      <View style={styles.lleno}>
        <MuroDePublicaciones
          cabecera={cabecera}
          pie={pie}
          alRefrescar={cargarDestacados}
          espacioInferior={espacioParaLaBarra(insets.bottom) + spacing.xl}
        />

        {/*
          Los resultados se pintan ENCIMA del muro, no en su lugar. Sustituirlo
          desmontaria la lista y, al borrar la busqueda, volveria a pedirlo todo
          y perderia la posicion de lectura.
        */}
        {isSearching ? (
          <ScrollView
            style={[styles.resultados, { backgroundColor: colors.background }]}
            contentContainerStyle={{ paddingBottom: espacioParaLaBarra(insets.bottom) }}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.container}>
              {/*
                TRES ESTADOS Y NO DOS, y la diferencia es justo la de la queja:

                · «No pudimos buscar» cuando la peticion fallo. Decir «no hay
                  resultados» cuando en realidad no se pudo preguntar hace creer
                  que lo buscado no existe en la aplicacion.
                · «Sin resultados» SOLO cuando ya hay una respuesta y viene
                  vacia de los CINCO grupos —lo comprueba
                  `debeDecirSinResultados`, que ademas espera a que no haya una
                  busqueda pendiente para no parpadear entre letra y letra—. El
                  texto ya no habla de nombres: aqui se busca de todo.
                · Cargando mientras tanto.
              */}
              <StateView
                state={
                  estado.fallo
                    ? 'error'
                    : debeDecirSinResultados(estado)
                    ? 'empty'
                    : filasDeBusqueda.length === 0
                    ? 'loading'
                    : 'content'
                }
                icon="search"
                title={
                  estado.fallo
                    ? t('search.failedTitle')
                    : debeDecirSinResultados(estado)
                    ? t('search.emptyTitle')
                    : undefined
                }
                description={
                  estado.fallo
                    ? t('common.checkConnection')
                    : debeDecirSinResultados(estado)
                    ? t('search.emptyBody', { termino: estado.termino })
                    : undefined
                }
                onRetry={
                  estado.fallo ? () => buscar(normalizarTermino(query)) : undefined
                }
              >
                {/*
                  Mientras llega la respuesta nueva se siguen viendo los
                  resultados anteriores con este aviso encima: vaciar la lista en
                  cada tecla convierte escribir en un parpadeo y esconde justo el
                  resultado que a lo mejor ya estaba en pantalla.
                */}
                {estaOcupado(estado) && filasDeBusqueda.length > 0 ? (
                  <Text style={[styles.buscandoAviso, { color: colors.textMuted }]}>
                    {t('search.searching')}
                  </Text>
                ) : null}
                {filasDeBusqueda.map((fila) => (
                  <FilaDeResultado key={fila.key} fila={fila} />
                ))}
              </StateView>
            </View>
          </ScrollView>
        ) : null}
      </View>

      {creating ? (
        <CreateCatalogSheet
          kind={creating}
          visible
          onClose={() => setCreating(null)}
          onCreated={() => void loadFeed()}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  lleno: { flex: 1 },
  container: { paddingHorizontal: spacing.lg },
  buscador: { paddingTop: spacing.sm },
  avisoCarga: { paddingVertical: spacing.md },
  buscandoAviso: { paddingVertical: spacing.sm, fontSize: 13 },
  // La forma y el foco los lleva `CampoDeBusqueda`; aqui solo el hueco de debajo.
  campoDeBusqueda: { marginBottom: spacing.md },
  listaVacia: { fontSize: 13, lineHeight: 18, paddingVertical: spacing.sm },
  resultados: { ...StyleSheet.absoluteFillObject, zIndex: 5 },
  tabs: { marginBottom: spacing.lg },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  composerAvatar: { width: 40, height: 40, borderRadius: 20 },
  composerText: { flex: 1, fontSize: 13 },
  quickRow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.lg },
  quickCard: { flex: 1, minHeight: 136, borderRadius: radius.lg, padding: spacing.lg, justifyContent: 'space-between' },
  quickHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  addBadge: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  addChip: { borderWidth: 1, borderRadius: radius.pill, paddingVertical: 5, paddingHorizontal: 10, alignSelf: 'flex-start' },
  addChipText: { fontSize: 10, fontWeight: '700' },
  quickTitle: { fontSize: 15, fontWeight: '900', marginTop: spacing.md },
  quickBody: { fontSize: 11, lineHeight: 16, opacity: 0.82 },
  seeMoreText: { fontSize: 13, fontWeight: '700' },
  seeMore: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    alignSelf: 'center',
    marginTop: spacing.md,
    marginBottom: spacing.lg,
    paddingHorizontal: spacing.lg,
    minHeight: 36,
    borderWidth: 1,
    borderRadius: radius.pill,
  },
  heroCard: { height: 280, borderRadius: radius.xl, overflow: 'hidden', marginBottom: spacing.xl, justifyContent: 'flex-end' },
  heroOverlay: { ...StyleSheet.absoluteFillObject },
  heroContent: { padding: spacing.xl },
  eyebrow: { color: '#D0D0D0', fontSize: 10, fontWeight: '800', letterSpacing: 1.3 },
  heroTitle: { color: '#FFFFFF', fontSize: 24, lineHeight: 30, fontWeight: '900', marginVertical: spacing.sm },
  heroBody: { color: '#E2E2E2', fontSize: 13 },
  list: { marginBottom: spacing.xl },
  eventImage: { width: 50, height: 50, borderRadius: radius.md },
  circle: {
    borderRadius: radius.xl,
    padding: spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xl,
  },
  circleTitle: { fontSize: 20, fontWeight: '900', marginTop: spacing.sm },
  circleBody: { fontSize: 12, lineHeight: 17, opacity: 0.82, marginTop: spacing.sm },
  circleIcon: { marginLeft: spacing.md },
});
