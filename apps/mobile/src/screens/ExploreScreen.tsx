import React, { useCallback, useEffect, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader } from '@/components/AppHeader';
import { Avatar } from '@/components/Avatar';
import { CoachMark } from '@/components/CoachMark';
import { CreateCatalogSheet, type CatalogKind } from '@/components/CreateCatalogSheet';
import { CursosParaTi } from '@/components/CursosParaTi';
import { espacioParaLaBarra } from '@/components/FloatingGlassTabBar';
import { Input } from '@/components/Input';
import { ListRow } from '@/components/ListRow';
import { MuroDePublicaciones } from '@/components/MuroDePublicaciones';
import { PersonasParaTi } from '@/components/PersonasParaTi';
import type { ProfileSectionKind } from '@/components/ProfileSection';
import { SectionTitle } from '@/components/SectionTitle';
import { SegmentedControl } from '@/components/SegmentedControl';
import { StateView } from '@/components/StateView';
import { StoriesRow } from '@/components/StoriesRow';
import { assets } from '@/data/assets';
import { useTranslation } from '@/i18n/useTranslation';
import { DARREN_NOTICE_ID } from '@/lib/guides';
import { AuthRepository } from '@/repositories/AuthRepository';
import { CatalogRepository } from '@/repositories/CatalogRepository';
import { CommunityRepository, type CircleDetail } from '@/repositories/CommunityRepository';
import { LearningRepository } from '@/repositories/LearningRepository';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import { resultadoAbierto } from '@/services/senales';
import { profileImageUrl } from '@/services/storage';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { ProfileSummary } from '@/mappers/profileMapper';
import type { Course, EventItem } from '@/types';

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
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);

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
      LearningRepository.listCourses(),
      CatalogRepository.listEvents(),
      CommunityRepository.list(),
      ProfileRepository.listFeatured(),
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
      El catalogo es contenido SECUNDARIO de esta pantalla y se retrasa a
      proposito: en el arranque compite con el muro por la misma conexion y por
      un servidor recien despierto, y lo que la persona vino a ver son las
      publicaciones. Medio segundo despues llega sin que nadie lo note.
    */
    const timer = setTimeout(() => void cargarDestacados(), 600);
    return () => clearTimeout(timer);
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
  const openAdminSection = (section: ProfileSectionKind) => {
    if (!catalogProfileId) return;
    router.push({ pathname: '/profile/[id]', params: { id: catalogProfileId, section } } as never);
  };

  /**
   * El aviso de contenido gratuito de Darren vive en Notificaciones. Aqui solo
   * se consulta si sigue pendiente para pintar el punto en la campana; no tiene
   * sentido para el propio Darren.
   */
  const darrenNoticePending = useAppStore(
    (state) => !state.dismissedGuides.includes(DARREN_NOTICE_ID) && state.user?.isAdmin !== true,
  );

  // Antes el indice se guardaba pero no se usaba: ambas pestañas mostraban el
  // mismo feed global. Ahora "Siguiendo" pide al backend solo lo de los
  // perfiles que sigue el usuario.
  const [feedTab, setFeedTab] = useState(0);
  const changeTab = (index: number) => {
    setFeedTab(index);
    void loadFeed(index === 1 ? 'following' : 'all');
  };

  /* ---------------------------------------------------------- Busqueda ---- */
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProfileSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [busquedaFallida, setBusquedaFallida] = useState(false);
  /*
    Contador que fuerza a repetir la busqueda al pulsar «reintentar».
    Hace falta uno explicito: el termino no ha cambiado, asi que sin esto el
    efecto no se volveria a ejecutar y el boton no haria nada.
  */
  const [reintentoBusqueda, setReintentoBusqueda] = useState(0);

  const term = query.trim();
  const isSearching = term.length >= 2;

  useEffect(() => {
    if (!isSearching || !supabaseEnabled) {
      setResults([]);
      return;
    }
    let active = true;
    setSearching(true);
    setBusquedaFallida(false);
    const handle = setTimeout(() => {
      ProfileRepository.search(term)
        .then((data) => {
          if (active) setResults(data);
        })
        .catch((error) => {
          // «No encontramos a nadie» cuando en realidad no se pudo preguntar
          // hace pensar que la persona buscada no esta en la aplicacion.
          console.warn('[explorar] la busqueda de personas fallo', error);
          if (active) {
            setResults([]);
            setBusquedaFallida(true);
          }
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 350);
    return () => {
      active = false;
      clearTimeout(handle);
    };
  }, [term, isSearching, supabaseEnabled, reintentoBusqueda]);

  /* --------------------------------------------------------- Contenido ---- */

  const cabecera = (
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
          accessibilityLabel="Crear nueva publicación"
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
          text="Comparte tu primera publicación con la comunidad."
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
  );

  const pie = (
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
            title="No pudimos cargar el contenido"
            description="Revisa tu conexión e inténtalo de nuevo."
            onRetry={() => void cargarDestacados()}
          />
        </View>
      ) : null}

      <SectionTitle title="Tu siguiente paso" />
      {/*
        Guia hacia el contenido: sin ella la portada se lee como una imagen
        decorativa y no como algo en lo que se puede entrar. Solo aparece si hay
        un curso real que abrir.
      */}
      <CoachMark
        id="explorar-programa"
        arrow="down"
        visible={!!featuredCourse}
        text="Entra al programa recomendado y empieza por el primer módulo."
        onPress={() => featuredCourse && router.push(`/course/${featuredCourse.id}` as never)}
      />
      <Pressable
        onPress={() => featuredCourse && router.push(`/course/${featuredCourse.id}` as never)}
        disabled={!featuredCourse}
        style={styles.heroCard}
        accessibilityLabel={`Programa recomendado: ${featuredCourse?.title ?? ''}`}
        accessibilityRole="button"
      >
        <Image source={assets.course} style={StyleSheet.absoluteFill} resizeMode="cover" />
        <View style={[styles.heroOverlay, { backgroundColor: colors.overlay }]} />
        <View style={styles.heroContent}>
          <Text style={styles.eyebrow}>PROGRAMA RECOMENDADO</Text>
          <Text style={styles.heroTitle}>{featuredCourse?.title ?? 'Programas en camino'}</Text>
          <Text style={styles.heroBody}>
            {featuredCourse
              ? featuredCourse.subtitle
              : catalogoFallido
              ? 'No pudimos cargar el programa.'
              : 'Muy pronto habrá contenido disponible.'}
          </Text>
        </View>
      </Pressable>

      <SectionTitle title="Próximos eventos" action="Ver calendario" onActionPress={() => router.push('/events')} />
      <View style={styles.list}>
        {nextEvents.slice(0, 2).map((event, index) => (
          <ListRow
            key={event.id}
            title={event.title}
            subtitle={`${event.date} • ${event.location}`}
            leftComponent={
              <Image source={index === 0 ? assets.event : assets.speaker} style={styles.eventImage} />
            }
            rightIcon="chevron-right"
            onPress={() => router.push('/events')}
          />
        ))}
      </View>

      <SectionTitle title="Comunidades" />
      <Pressable
        onPress={() => featuredCircle && router.push(`/circle/${featuredCircle.id}` as never)}
        disabled={!featuredCircle}
        style={[styles.circle, { backgroundColor: colors.primary }]}
        accessibilityLabel={`Círculo: ${featuredCircle?.name ?? ''}`}
        accessibilityRole="button"
      >
        <View style={{ flex: 1 }}>
          <Text style={[styles.eyebrow, { color: colors.onPrimary }]}>CÍRCULO PRIVADO</Text>
          <Text style={[styles.circleTitle, { color: colors.onPrimary }]}>
            {featuredCircle?.name ?? 'Círculos'}
          </Text>
          <Text style={[styles.circleBody, { color: colors.onPrimary }]}>
            {featuredCircle
              ? `Conecta, comparte y crece con ${featuredCircle.members} miembros.`
              : catalogoFallido
              ? 'No pudimos cargar los círculos.'
              : 'Muy pronto podrás unirte a un círculo.'}
          </Text>
        </View>
        <Feather name="users" size={48} color={colors.onPrimary} style={styles.circleIcon} />
      </Pressable>
      </View>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title="EXPLORAR"
        rightIcon="bell"
        // Un aviso que nadie abre no sirve de nada: el punto marca que el de
        // "contenido de Darren gratis" sigue esperando dentro.
        rightBadge={darrenNoticePending}
        onRightPress={() => router.push('/notifications')}
      />

      {/*
        El buscador va FIJO, fuera de la lista. Dentro se iba con el
        desplazamiento y buscar a alguien obligaba a subir hasta arriba del
        todo; ahora es el primer elemento de la pantalla y siempre esta ahi.
      */}
      <View style={[styles.container, styles.buscador]}>
        <View style={styles.searchWrapper}>
          <Input
            placeholder="Buscar personas..."
            placeholderTextColor={colors.textMuted}
            containerStyle={styles.searchContainer}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={styles.searchIcon}>
            <Feather name="search" size={18} color={colors.textMuted} />
          </View>
        </View>
      </View>

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
              <StateView
                state={
                  searching
                    ? 'loading'
                    : busquedaFallida
                    ? 'error'
                    : results.length === 0
                    ? 'empty'
                    : 'content'
                }
                title={
                  !searching && busquedaFallida
                    ? 'No pudimos buscar'
                    : !searching && results.length === 0
                    ? 'Sin resultados'
                    : undefined
                }
                description={
                  !searching && busquedaFallida
                    ? 'Revisa tu conexión e inténtalo de nuevo.'
                    : !searching && results.length === 0
                    ? 'No encontramos personas con ese nombre.'
                    : undefined
                }
                onRetry={busquedaFallida ? () => setReintentoBusqueda((n) => n + 1) : undefined}
              >
                {results.map((person) => (
                  <ListRow
                    key={person.id}
                    title={person.fullName}
                    subtitle={person.username}
                    leftComponent={
                      // Antes se pasaba siempre el avatar generico, asi que
                      // quien tenia foto salia igualmente con la silueta por
                      // defecto y no habia forma de reconocer a nadie.
                      <Avatar
                        size={40}
                        image={profileImageUrl(person.avatarPath) ?? null}
                        name={person.fullName}
                      />
                    }
                    rightIcon="chevron-right"
                    onPress={() => {
                      /*
                        Elegir un resultado dice QUE se buscaba de verdad. Se
                        guarda a quien se abrio, NUNCA lo que se escribio: un
                        termino de busqueda puede contener cualquier cosa y no
                        hace falta para ordenar nada.
                      */
                      resultadoAbierto('profile', person.id);
                      router.push(`/profile/${person.id}` as never);
                    }}
                  />
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
  searchWrapper: { position: 'relative', marginBottom: spacing.md },
  searchContainer: { paddingLeft: 30 },
  searchIcon: { position: 'absolute', left: spacing.md, top: 15 },
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
