import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppScreen } from '@/components/AppScreen';
import { AppHeader } from '@/components/AppHeader';
import { SegmentedControl } from '@/components/SegmentedControl';
import { StateView } from '@/components/StateView';
import { ListRow } from '@/components/ListRow';
import { useAppStore } from '@/store/useAppStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function LibraryScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const purchasedCourseIds = useAppStore((state) => state.purchasedCourseIds);

  const [activeTab, setActiveTab] = useState(0);

  const hasCourses = purchasedCourseIds.length > 0;
  const hasAudios = audios.length > 0;

  const activeState = activeTab === 0 ? (hasCourses ? 'content' : 'empty') : (hasAudios ? 'content' : 'empty');

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="Mi Biblioteca" />
      <View style={styles.header}>
        <SegmentedControl
          options={['Mis Cursos', 'Mis Audios']}
          selectedIndex={activeTab}
          onChange={setActiveTab}
        />
      </View>

      <StateView
        state={activeState}
        title={activeTab === 0 ? 'No tienes cursos adquiridos' : 'Historial de audios vacío'}
        description={
          activeTab === 0
            ? 'Adquiere un curso para verlo disponible en tu biblioteca.'
            : 'Los audios que escuches se guardarán aquí.'
        }
        icon={activeTab === 0 ? 'book' : 'headphones'}
      >
        <ScrollView contentContainerStyle={styles.list}>
          {activeTab === 0
            ? purchasedCourseIds.map((courseId) => (
                <ListRow
                  key={courseId}
                  title={courseId === 'lider-vida-empresa' ? 'Líder de tu Vida y Empresa' : courseId}
                  subtitle="Darren Hardy • 12 Lecciones"
                  leftIcon="play-circle"
                  rightIcon="chevron-right"
                  onPress={() => router.push(`/lesson/1` as any)}
                />
              ))
            : audios.map((audio) => (
                <ListRow
                  key={audio.id}
                  title={audio.title}
                  subtitle={audio.subtitle}
                  leftIcon="headphones"
                  rightIcon="play"
                  onPress={() => router.push(`/audio/${audio.id}` as any)}
                />
              ))}
        </ScrollView>
      </StateView>
    </View>
  );
}

// Audios disponibles en la biblioteca (mock). Al integrar backend vendrán del repositorio.
const audios = [
  { id: 'private', title: 'Tu enfoque de esta semana', subtitle: 'Audio guiado • 3 min' },
  { id: 'disciplina', title: 'El poder de la disciplina diaria', subtitle: 'Audio guiado • 5 min' },
];

const styles = StyleSheet.create({
  header: {
    padding: spacing.lg,
  },
  list: {
    paddingHorizontal: spacing.lg,
  },
});
