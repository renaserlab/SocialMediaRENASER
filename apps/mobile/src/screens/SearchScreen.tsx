import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { Input } from '@/components/Input';
import { ListRow } from '@/components/ListRow';
import { SectionTitle } from '@/components/SectionTitle';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { assets } from '@/data/assets';
import { AuthRepository } from '@/repositories/AuthRepository';
import { CatalogRepository } from '@/repositories/CatalogRepository';
import { LearningRepository } from '@/repositories/LearningRepository';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import type { ProfileSummary } from '@/mappers/profileMapper';
import { profileImageUrl } from '@/services/storage';
import { useAppStore } from '@/store/useAppStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Course, EventItem, Post } from '@/types';

const RECENTS_KEY = 'renaser-recent-searches';
const MAX_RECENTS = 6;

type CatalogHit = { id: string; title: string; subtitle: string; href: string };

/** Fila de la lista aplanada (secciones + resultados en una sola FlashList). */
type SearchRow =
  | { kind: 'section'; key: string; title: string; onAction?: () => void }
  | { kind: 'recent'; key: string; value: string }
  | { kind: 'person'; key: string; person: ProfileSummary }
  | { kind: 'post'; key: string; post: Post }
  | { kind: 'catalog'; key: string; item: CatalogHit };

export function SearchScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const posts = useAppStore((state) => state.posts);

  const [query, setQuery] = useState('');
  const [recents, setRecents] = useState<string[]>([]);

  useEffect(() => {
    AsyncStorage.getItem(RECENTS_KEY)
      .then((raw) => {
        if (raw) setRecents(JSON.parse(raw) as string[]);
      })
      .catch(() => {});
  }, []);

  const persistRecent = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length < 2) return;
    const next = [trimmed, ...recents.filter((r) => r !== trimmed)].slice(0, MAX_RECENTS);
    setRecents(next);
    AsyncStorage.setItem(RECENTS_KEY, JSON.stringify(next)).catch(() => {});
  };

  const clearRecents = () => {
    setRecents([]);
    AsyncStorage.removeItem(RECENTS_KEY).catch(() => {});
  };

  const term = query.trim().toLowerCase();
  const isSearching = term.length >= 2;

  // Personas: busqueda en el backend, no sobre una lista fija de demo.
  const [remotePeople, setRemotePeople] = useState<ProfileSummary[]>([]);
  useEffect(() => {
    if (!isSearching || !AuthRepository.enabled) {
      setRemotePeople([]);
      return;
    }
    let alive = true;
    // Pequeña espera para no lanzar una peticion por cada tecla.
    const timer = setTimeout(() => {
      ProfileRepository.search(term)
        .then((list) => {
          if (alive) setRemotePeople(list);
        })
        .catch(() => {
          if (alive) setRemotePeople([]);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [term, isSearching]);

  // Catalogo real, cargado una vez.
  const [courses, setCourses] = useState<Course[]>([]);
  const [allEvents, setAllEvents] = useState<EventItem[]>([]);
  useEffect(() => {
    if (!AuthRepository.enabled) return;
    // Si el catalogo no carga, buscar un curso devuelve «sin resultados» y
    // parece que ese curso no existe. Queda constancia en el log.
    LearningRepository.listCourses()
      .then(setCourses)
      .catch((error) => {
        console.warn('[buscar] no se pudo cargar el catalogo de cursos', error);
        setCourses([]);
      });
    CatalogRepository.listEvents()
      .then((page) => setAllEvents(page.items))
      .catch((error) => {
        console.warn('[buscar] no se pudieron cargar los eventos', error);
        setAllEvents([]);
      });
  }, []);

  const results = useMemo(() => {
    if (!isSearching) return { people: [], posts: [], catalog: [] };
    const match = (text: string) => text.toLowerCase().includes(term);
    return {
      // Las personas las resuelve el backend (ver el efecto de arriba); el
      // catalogo se filtra en cliente porque son pocos elementos.
      people: remotePeople,
      posts: posts.filter((p) => match(p.body) || match(p.author)),
      catalog: [
        ...courses
          .filter((c) => match(c.title) || match(c.description))
          .map((c) => ({ id: c.id, title: c.title, subtitle: 'Programa', href: `/course/${c.id}` })),
        ...allEvents
          .filter((e) => match(e.title) || match(e.description))
          .map((e) => ({ id: e.id, title: e.title, subtitle: `${e.date} · ${e.location}`, href: '/events' })),
      ],
    };
  }, [term, isSearching, posts, remotePeople, courses, allEvents]);

  const total = results.people.length + results.posts.length + results.catalog.length;

  // Las 3 secciones se aplanan en una sola lista virtualizada: con datos reales
  // del backend, mapear todo dentro de un ScrollView no escala.
  const rows = useMemo<SearchRow[]>(() => {
    if (!isSearching) {
      if (recents.length === 0) return [];
      return [
        { kind: 'section', key: 'sec-recents', title: 'Búsquedas recientes', onAction: clearRecents },
        ...recents.map((value) => ({ kind: 'recent' as const, key: `r-${value}`, value })),
      ];
    }
    const out: SearchRow[] = [];
    if (results.people.length > 0) {
      out.push({ kind: 'section', key: 'sec-people', title: 'Personas' });
      results.people.forEach((person) => out.push({ kind: 'person', key: `p-${person.id}`, person }));
    }
    if (results.posts.length > 0) {
      out.push({ kind: 'section', key: 'sec-posts', title: 'Publicaciones' });
      results.posts.forEach((post) => out.push({ kind: 'post', key: `o-${post.id}`, post }));
    }
    if (results.catalog.length > 0) {
      out.push({ kind: 'section', key: 'sec-catalog', title: 'Cursos y eventos' });
      results.catalog.forEach((item) => out.push({ kind: 'catalog', key: `c-${item.id}`, item }));
    }
    return out;
    // `recents`/`clearRecents` solo afectan al modo sin búsqueda.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSearching, results, recents]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title="Buscar"
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/explore'))}
      />

      <View style={styles.searchWrapper}>
        <Input
          placeholder="Personas, publicaciones, cursos o eventos..."
          placeholderTextColor={colors.textMuted}
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={() => persistRecent(query)}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          containerStyle={styles.searchInput}
        />
        <View style={styles.searchIcon}>
          <Feather name="search" size={18} color={colors.textMuted} />
        </View>
      </View>

      <FlashList
        data={rows}
        keyExtractor={(row: SearchRow) => row.key}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          isSearching && total === 0 ? (
            <StateView
              state="empty"
              icon="search"
              title="Sin resultados"
              description={`No encontramos nada para "${query.trim()}".`}
            />
          ) : (
            <StateView
              state="empty"
              icon="search"
              title="Busca en Z"
              description="Encuentra personas, publicaciones, cursos y eventos."
            />
          )
        }
        renderItem={({ item: row }: { item: SearchRow }) => {
          switch (row.kind) {
            case 'section':
              return <SectionTitle title={row.title} action={row.onAction ? 'Borrar' : undefined} onActionPress={row.onAction} />;
            case 'recent':
              return (
                <ListRow title={row.value} leftIcon="clock" rightIcon="chevron-right" onPress={() => setQuery(row.value)} />
              );
            case 'person':
              return (
                <ListRow
                  title={row.person.fullName}
                  subtitle={row.person.username}
                  leftComponent={
                    <ExpoImage
                      source={profileImageUrl(row.person.avatarPath) ? { uri: profileImageUrl(row.person.avatarPath)! } : assets.avatar}
                      style={styles.avatar}
                      contentFit="cover"
                      cachePolicy="memory-disk"
                    />
                  }
                  rightIcon="chevron-right"
                  onPress={() => {
                    persistRecent(query);
                    router.push(`/profile/${row.person.id}` as never);
                  }}
                />
              );
            case 'post':
              return (
                <Pressable
                  onPress={() => {
                    persistRecent(query);
                    router.push(`/post/${row.post.id}` as never);
                  }}
                  style={({ pressed }) => [styles.postRow, { borderBottomColor: colors.border, opacity: pressed ? 0.75 : 1 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Ver publicación de ${row.post.author}`}
                >
                  <Text variant="secondary" weight="700">{row.post.author}</Text>
                  <Text variant="body" color={colors.textMuted} numberOfLines={2}>{row.post.body}</Text>
                </Pressable>
              );
            case 'catalog':
              return (
                <ListRow
                  title={row.item.title}
                  subtitle={row.item.subtitle}
                  leftIcon="book"
                  rightIcon="chevron-right"
                  onPress={() => {
                    persistRecent(query);
                    router.push(row.item.href as never);
                  }}
                />
              );
          }
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  searchWrapper: { position: 'relative', paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  searchInput: { paddingLeft: 30 },
  searchIcon: { position: 'absolute', left: spacing.lg + spacing.md, top: 15 },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },
  avatar: { width: 40, height: 40, borderRadius: 20 },
  postRow: { paddingVertical: spacing.md, borderBottomWidth: 1, gap: 4 },
});
