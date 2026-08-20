import React, { useCallback, useEffect, useState } from 'react';
import { Image, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Avatar } from '@/components/Avatar';
import { CoachMark } from '@/components/CoachMark';
import { SectionTitle } from '@/components/SectionTitle';
import { Input } from '@/components/Input';
import { ListRow } from '@/components/ListRow';
import { StateView } from '@/components/StateView';
import { assets } from '@/data/assets';
import { AuthRepository } from '@/repositories/AuthRepository';
import { profileImageUrl } from '@/services/storage';
import { CatalogRepository } from '@/repositories/CatalogRepository';
import { CommunityRepository, type CircleDetail } from '@/repositories/CommunityRepository';
import { LearningRepository } from '@/repositories/LearningRepository';
import type { Course, EventItem } from '@/types';
import type { ProfileSummary } from '@/mappers/profileMapper';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function ExploreScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);

  // Destacados reales del catalogo. Antes el curso, los eventos y el circulo
  // eran los del paquete de demo, con "423 miembros" escrito a mano.
  const [featuredCourse, setFeaturedCourse] = useState<Course | null>(null);
  const [nextEvents, setNextEvents] = useState<EventItem[]>([]);
  const [featuredCircle, setFeaturedCircle] = useState<CircleDetail | null>(null);
  /*
    Que el servidor falle y que todavia no haya contenido NO son lo mismo.

    Antes los tres `.catch` se limitaban a dejar el estado a vacio, asi que una
    API caida se leia en pantalla como «Muy pronto habra contenido disponible»:
    una aplicacion rota parecia una aplicacion a medio llenar. Nadie reintentaba
    porque nada indicaba que hubiera fallado algo.
  */
  const [catalogoFallido, setCatalogoFallido] = useState(false);

  const cargarDestacados = useCallback(async () => {
    if (!AuthRepository.enabled) return;
    const [cursos, eventos, circulos] = await Promise.allSettled([
      LearningRepository.listCourses(),
      CatalogRepository.listEvents(),
      CommunityRepository.list(),
    ]);

    if (cursos.status === 'fulfilled') setFeaturedCourse(cursos.value[0] ?? null);
    if (eventos.status === 'fulfilled') setNextEvents(eventos.value.items);
    if (circulos.status === 'fulfilled') setFeaturedCircle(circulos.value[0] ?? null);

    const fallos = [cursos, eventos, circulos].filter((r) => r.status === 'rejected');
    // Se avisa solo si fallo TODO. Que una de las tres secciones no cargue no
    // justifica tapar la pantalla entera con un error.
    setCatalogoFallido(fallos.length === 3);
    for (const fallo of fallos) {
      console.warn('[explorar] no se pudo cargar una seccion', (fallo as PromiseRejectedResult).reason);
    }
  }, []);

  useEffect(() => {
    void cargarDestacados();
  }, [cargarDestacados]);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProfileSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [busquedaFallida, setBusquedaFallida] = useState(false);
  /*
    Contador que fuerza a repetir la busqueda al pulsar «reintentar».
    Hace falta uno explicito: el termino no ha cambiado, asi que sin esto el
    efecto no se volveria a ejecutar y el boton no haria nada —el mismo fallo
    que tenia el gesto de refrescar.
  */
  const [reintentoBusqueda, setReintentoBusqueda] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  /*
    Deslizar hacia abajo vuelve a pedir el catalogo.

    Antes hacia `setQuery((q) => q)`, que en React no cambia nada: el indicador
    aparecia y desaparecia sin lanzar ni una peticion. Justo el gesto al que se
    recurre cuando algo no ha cargado era el unico que no servia para nada.
  */
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await cargarDestacados();
    } finally {
      setRefreshing(false);
    }
  }, [cargarDestacados]);

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

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="EXPLORAR" rightIcon="search" onRightPress={() => router.push('/search' as never)} />
      <AppScreen
        contentStyle={{ paddingBottom: 120 }}
        scrollProps={{
          refreshControl: (
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text} colors={[colors.text]} />
          ),
        }}
      >
        <View style={styles.container}>
          {/* Campo de búsqueda */}
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

          {isSearching && (
            <View style={styles.results}>
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
                    onPress={() => router.push(`/profile/${person.id}` as never)}
                  />
                ))}
              </StateView>
            </View>
          )}

          {!isSearching && (
          <React.Fragment>
          {/*
            Un fallo del servidor se dice, no se disfraza de «todavia no hay
            nada». Lleva icono y texto ademas del color, y ofrece la salida
            (reintentar) en el mismo sitio donde se ve el problema.
          */}
          {catalogoFallido && (
            <View style={styles.avisoCarga}>
              <StateView
                state="error"
                icon="wifi-off"
                title="No pudimos cargar el contenido"
                description="Revisa tu conexión e inténtalo de nuevo."
                onRetry={() => void cargarDestacados()}
              />
            </View>
          )}
          <SectionTitle title="Tu siguiente paso" />
          {/*
            Guia hacia el contenido: sin ella la portada se lee como una imagen
            decorativa y no como algo en lo que se puede entrar. Solo aparece si
            hay un curso real que abrir.
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

          <SectionTitle title="Shorts" action="Ver todos" onActionPress={() => router.push('/reels' as never)} />
          <View style={styles.list}>
            <ListRow
              title="Shorts de la comunidad"
              subtitle="Videos cortos para avanzar en minutos"
              leftIcon="play-circle"
              rightIcon="chevron-right"
              onPress={() => router.push('/reels' as never)}
            />
          </View>

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
            accessibilityLabel={`Círculo: ${featuredCircle?.name ?? ""}`}
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
          </React.Fragment>
          )}
        </View>
      </AppScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing.lg },
  avisoCarga: { paddingVertical: spacing.md },
  searchWrapper: {
    position: 'relative',
    marginBottom: spacing.xl,
  },
  searchContainer: {
    paddingLeft: 30,
  },
  searchIcon: {
    position: 'absolute',
    left: spacing.md,
    top: 15,
  },
  results: {
    marginBottom: spacing.xl,
    minHeight: 120,
  },
  heroCard: { height: 280, borderRadius: radius.xl, overflow: 'hidden', marginBottom: spacing.xl, justifyContent: 'flex-end' },
  heroOverlay: { ...StyleSheet.absoluteFillObject },
  heroContent: { padding: spacing.xl },
  eyebrow: { color: '#D0D0D0', fontSize: 10, fontWeight: '800', letterSpacing: 1.3 },
  heroTitle: { color: '#FFFFFF', fontSize: 24, lineHeight: 30, fontWeight: '900', marginVertical: spacing.sm },
  heroBody: { color: '#E2E2E2', fontSize: 13 },
  list: {
    marginBottom: spacing.xl,
  },
  eventImage: { width: 50, height: 50, borderRadius: radius.md },
  circle: { borderRadius: radius.xl, padding: spacing.xl, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.xl },
  circleTitle: { fontSize: 20, fontWeight: '900', marginTop: spacing.sm },
  circleBody: { fontSize: 12, lineHeight: 17, opacity: 0.82, marginTop: spacing.sm },
  circleIcon: {
    marginLeft: spacing.md,
  },
});
