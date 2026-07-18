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

  // Mapeamos los cursos comprados si existen. Por defecto, en el mock puede empezar vacío
  const hasCourses = purchasedCourseIds.length > 0;
  // Para propósitos del demo, "Mis Audios" empieza vacío para detonar el state vacío
  const hasAudios = false;

  const getActiveState = () => {
    if (activeTab === 0) {
      return hasCourses ? 'content' : 'empty';
    }
    return hasAudios ? 'content' : 'empty';
  };

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
        state={getActiveState()}
        title={activeTab === 0 ? 'No tienes cursos adquiridos' : 'Historial de audios vacío'}
        description={
          activeTab === 0
            ? 'Adquiere un curso para verlo disponible en tu biblioteca.'
            : 'Los audios que escuches se guardarán aquí.'
        }
        icon={activeTab === 0 ? 'book' : 'headphones'}
      >
        <ScrollView contentContainerStyle={styles.list}>
          {purchasedCourseIds.map((courseId) => (
            <ListRow
              key={courseId}
              title={courseId === 'lider-vida-empresa' ? 'Líder de tu Vida y Empresa' : courseId}
              subtitle="Darren Hardy • 12 Lecciones"
              leftIcon="play-circle"
              rightIcon="chevron-right"
              onPress={() => router.push(`/lesson/1` as any)}
            />
          ))}
        </ScrollView>
      </StateView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    padding: spacing.lg,
  },
  list: {
    paddingHorizontal: spacing.lg,
  },
});
