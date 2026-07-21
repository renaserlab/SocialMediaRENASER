import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
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
import { course, events, people } from '@/data/mockData';
import { useAppStore } from '@/store/useAppStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

const RECENTS_KEY = 'renaser-recent-searches';
const MAX_RECENTS = 6;

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

  const results = useMemo(() => {
    if (!isSearching) return { people: [], posts: [], catalog: [] };
    const match = (text: string) => text.toLowerCase().includes(term);
    return {
      people: people.filter((p) => match(p.fullName) || match(p.username)),
      posts: posts.filter((p) => match(p.body) || match(p.author)),
      catalog: [
        ...(match(course.title) ? [{ id: course.id, title: course.title, subtitle: 'Programa', href: `/course/${course.id}` }] : []),
        ...events
          .filter((e) => match(e.title) || match(e.description))
          .map((e) => ({ id: e.id, title: e.title, subtitle: `${e.date} · ${e.location}`, href: '/events' })),
      ],
    };
  }, [term, isSearching, posts]);

  const total = results.people.length + results.posts.length + results.catalog.length;

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

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {!isSearching ? (
          recents.length > 0 ? (
            <React.Fragment>
              <SectionTitle title="Búsquedas recientes" action="Borrar" onActionPress={clearRecents} />
              {recents.map((item) => (
                <ListRow
                  key={item}
                  title={item}
                  leftIcon="clock"
                  rightIcon="chevron-right"
                  onPress={() => setQuery(item)}
                />
              ))}
            </React.Fragment>
          ) : (
            <StateView
              state="empty"
              icon="search"
              title="Busca en RENASER"
              description="Encuentra personas, publicaciones, cursos y eventos."
            />
          )
        ) : total === 0 ? (
          <StateView
            state="empty"
            icon="search"
            title="Sin resultados"
            description={`No encontramos nada para "${query.trim()}".`}
          />
        ) : (
          <React.Fragment>
            {results.people.length > 0 && (
              <React.Fragment>
                <SectionTitle title="Personas" />
                {results.people.map((person) => (
                  <ListRow
                    key={person.id}
                    title={person.fullName}
                    subtitle={person.username}
                    leftComponent={<ExpoImage source={assets[person.avatar]} style={styles.avatar} contentFit="cover" />}
                    rightIcon="chevron-right"
                    onPress={() => {
                      persistRecent(query);
                      router.push(`/profile/${person.id}` as never);
                    }}
                  />
                ))}
              </React.Fragment>
            )}

            {results.posts.length > 0 && (
              <React.Fragment>
                <SectionTitle title="Publicaciones" />
                {results.posts.map((post) => (
                  <Pressable
                    key={post.id}
                    onPress={() => {
                      persistRecent(query);
                      router.push(`/post/${post.id}` as never);
                    }}
                    style={({ pressed }) => [styles.postRow, { borderBottomColor: colors.border, opacity: pressed ? 0.75 : 1 }]}
                    accessibilityRole="button"
                    accessibilityLabel={`Ver publicación de ${post.author}`}
                  >
                    <Text variant="secondary" weight="700">{post.author}</Text>
                    <Text variant="body" color={colors.textMuted} numberOfLines={2}>{post.body}</Text>
                  </Pressable>
                ))}
              </React.Fragment>
            )}

            {results.catalog.length > 0 && (
              <React.Fragment>
                <SectionTitle title="Cursos y eventos" />
                {results.catalog.map((item) => (
                  <ListRow
                    key={item.id}
                    title={item.title}
                    subtitle={item.subtitle}
                    leftIcon="book"
                    rightIcon="chevron-right"
                    onPress={() => {
                      persistRecent(query);
                      router.push(item.href as never);
                    }}
                  />
                ))}
              </React.Fragment>
            )}
          </React.Fragment>
        )}
      </ScrollView>
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
