import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Avatar } from '@/components/Avatar';
import { PostCard } from '@/components/PostCard';
import { assets } from '@/data/assets';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

const stories = [
  { label: 'Tu historia', image: 'avatar' as const },
  { label: 'Reto diario', image: 'speaker' as const },
  { label: 'Alquimia', image: 'hero' as const },
  { label: 'Comunidad', image: 'avatar' as const },
  { label: 'En vivo', image: 'speaker' as const },
];

export function HomeScreen() {
  const { colors } = useAppTheme();
  const posts = useAppStore((state) => state.posts);
  const user = useAppStore((state) => state.user);

  return (
    <AppScreen contentStyle={{ paddingBottom: 100 }}>
      <AppHeader title="RENASER" rightIcon="notifications-outline" onRightPress={() => router.push('/events')} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.stories}>
        {stories.map((story) => <Avatar key={story.label} label={story.label} image={story.image} size={58} />)}
      </ScrollView>

      <View style={styles.container}>
        <Pressable
          onPress={() => router.push('/(tabs)/create')}
          style={[styles.composer, { backgroundColor: colors.surface, borderColor: colors.border }]}
        >
          <Image source={assets.avatar} style={styles.composerAvatar} />
          <Text style={[styles.composerText, { color: colors.textMuted }]}>¿Qué estás aprendiendo hoy, {user?.fullName.split(' ')[0] ?? 'Katherine'}?</Text>
          <Ionicons name="add-circle-outline" size={24} color={colors.text} />
        </Pressable>

        <View style={styles.quickRow}>
          <Pressable onPress={() => router.push('/audio/private')} style={[styles.quickCard, { backgroundColor: colors.primary }]}>
            <Ionicons name="headset-outline" size={24} color={colors.onPrimary} />
            <Text style={[styles.quickTitle, { color: colors.onPrimary }]}>Audio privado</Text>
            <Text style={[styles.quickBody, { color: colors.onPrimary }]}>Recomendación basada en tu quiz</Text>
          </Pressable>
          <Pressable onPress={() => router.push('/circle/lideres-renaser')} style={[styles.quickCard, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 }]}>
            <Ionicons name="people-outline" size={24} color={colors.text} />
            <Text style={[styles.quickTitle, { color: colors.text }]}>Tu círculo</Text>
            <Text style={[styles.quickBody, { color: colors.textMuted }]}>423 personas avanzando</Text>
          </Pressable>
        </View>

        {posts.map((post) => <PostCard key={post.id} post={post} />)}
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  stories: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.md },
  container: { paddingHorizontal: spacing.lg },
  composer: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: radius.lg, padding: spacing.md, gap: spacing.md, marginBottom: spacing.lg },
  composerAvatar: { width: 40, height: 40, borderRadius: 20 },
  composerText: { flex: 1, fontSize: 13 },
  quickRow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.lg },
  quickCard: { flex: 1, minHeight: 148, borderRadius: radius.lg, padding: spacing.lg, justifyContent: 'space-between' },
  quickTitle: { fontSize: 16, fontWeight: '900', marginTop: spacing.lg },
  quickBody: { fontSize: 11, lineHeight: 16, opacity: 0.82 },
});
