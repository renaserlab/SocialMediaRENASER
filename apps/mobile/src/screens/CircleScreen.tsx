import { Ionicons } from '@expo/vector-icons';
import { Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { assets } from '@/data/assets';
import { circle } from '@/data/mockData';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

const circlePosts = [
  { author: 'Darren Supa', text: 'Bienvenidos a este espacio. Aquí compartimos, aprendemos y nos impulsamos a nuestro siguiente nivel.', likes: 128, comments: 24 },
  { author: 'Ana Sofía', text: 'Hoy puse un límite que llevaba meses postergando. Se sintió incómodo, pero también liberador.', likes: 84, comments: 17 },
];

export function CircleScreen() {
  const { colors } = useAppTheme();
  return (
    <AppScreen contentStyle={{ paddingBottom: spacing.xl }}>
      <AppHeader back title="CÍRCULO" rightIcon="ellipsis-horizontal" />
      <View style={styles.header}>
        <Image source={assets.circle} style={styles.circleImage} />
        <Text style={[styles.title, { color: colors.text }]}>{circle.name}</Text>
        <Text style={[styles.members, { color: colors.textMuted }]}>{circle.members} miembros</Text>
        <Text style={[styles.description, { color: colors.textMuted }]}>{circle.description}</Text>
      </View>
      <View style={[styles.tabs, { borderBottomColor: colors.border }]}>
        {['Feed', 'Chat', 'Recursos', 'Eventos'].map((tab, index) => <Text key={tab} style={{ color: index === 0 ? colors.text : colors.textMuted, fontWeight: index === 0 ? '900' : '600', fontSize: 12 }}>{tab}</Text>)}
      </View>
      <View style={styles.container}>
        <View style={[styles.composer, { backgroundColor: colors.surface }]}>
          <Image source={assets.avatar} style={styles.avatar} />
          <TextInput placeholder="Escribe algo..." placeholderTextColor={colors.textMuted} style={{ flex: 1, color: colors.text }} />
        </View>
        {circlePosts.map((post) => (
          <View key={post.author} style={[styles.post, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={styles.authorRow}><Image source={post.author === 'Darren Supa' ? assets.speaker : assets.avatar} style={styles.avatar} /><View><Text style={[styles.author, { color: colors.text }]}>{post.author}</Text><Text style={[styles.date, { color: colors.textMuted }]}>Hace 3 horas</Text></View><View style={{ flex: 1 }} /><Ionicons name="ellipsis-horizontal" size={20} color={colors.textMuted} /></View>
            <Text style={[styles.postText, { color: colors.text }]}>{post.text}</Text>
            <View style={styles.actions}><Pressable style={styles.action}><Ionicons name="heart-outline" size={20} color={colors.text} /><Text style={{ color: colors.text }}>{post.likes}</Text></Pressable><Pressable style={styles.action}><Ionicons name="chatbubble-outline" size={19} color={colors.text} /><Text style={{ color: colors.text }}>{post.comments}</Text></Pressable></View>
          </View>
        ))}
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', paddingHorizontal: spacing.xl },
  circleImage: { width: 112, height: 112, borderRadius: 56 },
  title: { fontSize: 23, lineHeight: 29, fontWeight: '900', textAlign: 'center', marginTop: spacing.md },
  members: { fontSize: 12, marginTop: 4 },
  description: { fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: spacing.md },
  tabs: { flexDirection: 'row', justifyContent: 'space-around', borderBottomWidth: 1, paddingVertical: spacing.lg, marginTop: spacing.lg },
  container: { padding: spacing.lg },
  composer: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderRadius: radius.pill, padding: spacing.sm, paddingHorizontal: spacing.md, marginBottom: spacing.lg },
  avatar: { width: 38, height: 38, borderRadius: 19 },
  post: { borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.md },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  author: { fontSize: 13, fontWeight: '900' },
  date: { fontSize: 10, marginTop: 2 },
  postText: { fontSize: 14, lineHeight: 21, marginVertical: spacing.lg },
  actions: { flexDirection: 'row', gap: spacing.xl },
  action: { flexDirection: 'row', alignItems: 'center', gap: 5 },
});
