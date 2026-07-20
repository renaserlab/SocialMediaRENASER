import React from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppScreen } from '@/components/AppScreen';
import { AppHeader } from '@/components/AppHeader';
import { Button } from '@/components/Button';
import { ListRow } from '@/components/ListRow';
import { spacing, radius } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { assets } from '@/data/assets';

export function LessonScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useAppTheme();
  const router = useRouter();

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="Lección del Curso" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Visual representation of video player */}
        <View style={[styles.playerContainer, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
          <Image source={assets.course} style={[styles.coverImage, { tintColor: 'gray' }]} />
          <View style={styles.playOverlay}>
            <Button label="Iniciar Lección" icon="play" onPress={() => {}} />
          </View>
        </View>

        <View style={styles.details}>
          <Text style={[styles.title, { color: colors.text }]}>
            Lección {id === '1' ? '1' : id}: El Poder de la Disciplina Diaria
          </Text>
          <Text style={[styles.duration, { color: colors.textMuted }]}>Duración: 18 min • Mentor: Darren Hardy</Text>

          <View style={[styles.divider, { backgroundColor: colors.border }]} />

          <Text style={[styles.sectionTitle, { color: colors.text }]}>Transcripción / Resumen</Text>
          <Text style={[styles.bodyText, { color: colors.text, lineHeight: 22 }]}>
            La disciplina es el puente entre tus metas y tus logros. El éxito no se consigue con saltos gigantescos,
            sino con la acumulación constante de pequeñas acciones diarias. En esta lección analizamos las rutinas matutinas
            que definen el día y cómo crear barreras contra la distracción en un mundo hiperconectado.
          </Text>

          <View style={[styles.divider, { backgroundColor: colors.border }]} />

          <Text style={[styles.sectionTitle, { color: colors.text }]}>Recursos del Curso</Text>
          <ListRow
            title="Guía de Trabajo PDF"
            subtitle="Planificador Diario.pdf (4.2 MB)"
            leftIcon="file-text"
            rightIcon="download"
            onPress={() => {}}
          />
          <ListRow
            title="Audio Resumen MP3"
            subtitle="Resumen de lección.mp3 (12.8 MB)"
            leftIcon="music"
            rightIcon="download"
            onPress={() => {}}
          />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    paddingBottom: spacing.xxl,
  },
  playerContainer: {
    height: 220,
    borderBottomWidth: 1,
    position: 'relative',
    justifyContent: 'center',
    alignItems: 'center',
  },
  coverImage: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  playOverlay: {
    position: 'absolute',
    alignSelf: 'center',
  },
  details: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  title: {
    fontSize: 18,
    fontWeight: '800',
  },
  duration: {
    fontSize: 13,
  },
  divider: {
    height: 1,
    marginVertical: spacing.sm,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  bodyText: {
    fontSize: 14,
  },
});
