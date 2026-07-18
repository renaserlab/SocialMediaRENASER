import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { PrimaryButton } from '@/components/PrimaryButton';
import { assets } from '@/data/assets';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function ProfileScreen() {
  const { colors, mode } = useAppTheme();
  const user = useAppStore((state) => state.user);
  const toggleTheme = useAppStore((state) => state.toggleTheme);
  const reset = useAppStore((state) => state.resetDemo);

  return (
    <AppScreen contentStyle={{ paddingBottom: 100 }}>
      <AppHeader title="PERFIL" rightIcon={mode === 'light' ? 'moon-outline' : 'sunny-outline'} onRightPress={toggleTheme} />
      <Image source={assets.hero} style={styles.cover} />
      <View style={[styles.profileBlock, { backgroundColor: colors.background }]}>
        <Image source={assets.avatar} style={[styles.avatar, { borderColor: colors.background }]} />
        <View style={styles.nameLine}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.name, { color: colors.text }]}>{user?.fullName ?? 'Darren Supa'}</Text>
            <Text style={[styles.username, { color: colors.textMuted }]}>{user?.username ?? '@darrensupa'}</Text>
          </View>
          <PrimaryButton label="Editar perfil" variant="secondary" onPress={() => {}} style={{ minHeight: 42 }} />
        </View>

        <View style={styles.stats}>
          <Stat label="Seguidores" value={user?.followers ?? 1200000} />
          <Stat label="Siguiendo" value={user?.following ?? 128} />
          <Stat label="Publicaciones" value={user?.posts ?? 1800} />
        </View>
        <Text style={[styles.bio, { color: colors.textMuted }]}>{user?.bio ?? 'Liderazgo · Mentalidad · Negocios. Te ayudo a descubrir tu siguiente nivel.'}</Text>
        <PrimaryButton label="Escuchar Audio Privado" icon="🎧" onPress={() => router.push('/audio/private')} />

        <View style={styles.shortcuts}>
          <Shortcut icon="headset-outline" label="Audios" onPress={() => router.push('/audio/private')} />
          <Shortcut icon="calendar-outline" label="Eventos" onPress={() => router.push('/events')} />
          <Shortcut icon="school-outline" label="Cursos" onPress={() => router.push('/course/lider-vida-empresa')} />
          <Shortcut icon="people-outline" label="Círculos" onPress={() => router.push('/circle/lideres-renaser')} />
        </View>

        <View style={styles.grid}>
          {[assets.audio, assets.event, assets.course, assets.circle, assets.speaker, assets.hero].map((source, index) => (
            <Image key={index} source={source} style={styles.gridImage} />
          ))}
        </View>

        <Pressable onPress={() => { reset(); router.replace('/'); }} style={[styles.reset, { borderColor: colors.border }]}>
          <Ionicons name="refresh" size={18} color={colors.danger} />
          <Text style={{ color: colors.danger, fontWeight: '700' }}>Restablecer demostración</Text>
        </Pressable>
      </View>
    </AppScreen>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  const { colors } = useAppTheme();
  const display = value >= 1000000 ? `${(value / 1000000).toFixed(1)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(value);
  return <View style={{ alignItems: 'center', flex: 1 }}><Text style={{ color: colors.text, fontWeight: '900', fontSize: 17 }}>{display}</Text><Text style={{ color: colors.textMuted, fontSize: 10 }}>{label}</Text></View>;
}

function Shortcut({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
  const { colors } = useAppTheme();
  return (
    <Pressable onPress={onPress} style={{ alignItems: 'center', gap: 5, flex: 1 }}>
      <View style={[styles.shortcutIcon, { backgroundColor: colors.surface, borderColor: colors.border }]}><Ionicons name={icon} size={21} color={colors.text} /></View>
      <Text style={{ color: colors.textMuted, fontSize: 10 }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cover: { width: '100%', height: 230 },
  profileBlock: { marginTop: -24, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: spacing.lg },
  avatar: { width: 102, height: 102, borderRadius: 51, borderWidth: 5, marginTop: -67 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.md },
  name: { fontSize: 25, fontWeight: '900' },
  username: { fontSize: 12, marginTop: 3 },
  stats: { flexDirection: 'row', marginVertical: spacing.xl },
  bio: { fontSize: 13, lineHeight: 19, marginBottom: spacing.lg },
  shortcuts: { flexDirection: 'row', marginVertical: spacing.xl },
  shortcutIcon: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 3 },
  gridImage: { width: '32.7%', aspectRatio: 1 },
  reset: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, borderWidth: 1, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.xl },
});
