import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { SegmentedControl } from '@/components/SegmentedControl';
import { StateView } from '@/components/StateView';
import { ListRow } from '@/components/ListRow';
import { AuthRepository } from '@/repositories/AuthRepository';
import { LearningRepository } from '@/repositories/LearningRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { MyCourse } from '@/types';

/**
 * Lo que esta persona tiene, desde el SERVIDOR.
 *
 * POR QUE CAMBIA. La pantalla se apoyaba en `purchasedCourseIds`, una lista
 * guardada en el telefono. Eso significaba que la biblioteca se vaciaba al
 * reinstalar, no se compartia entre dispositivos y podia seguir ensenando un
 * curso al que ya no se tiene acceso. Lo que alguien tiene es un hecho del
 * servidor, no una preferencia local.
 *
 * Y POR QUE SE SEPARAN LOS ESTADOS. «Empezado» y «terminado» piden cosas
 * opuestas de quien mira: uno invita a continuar y el otro a elegir algo nuevo.
 * Mezclarlos en una lista los convierte a los dos en ruido.
 */
export function LibraryScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();

  const [pestana, setPestana] = useState(0);
  const [cursos, setCursos] = useState<MyCourse[] | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    if (!AuthRepository.enabled) {
      setCursos([]);
      return;
    }
    try {
      setCursos(await LearningRepository.myCourses());
      setFallo(null);
    } catch (error) {
      // Sin biblioteca no se inventa una: se dice que no se pudo cargar.
      setFallo(error instanceof Error ? error.message : 'No se pudo cargar tu biblioteca.');
      setCursos([]);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  // Al volver de un curso el progreso ha cambiado: se vuelve a pedir en vez de
  // ensenar el porcentaje con el que se salio.
  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  const enCurso = (cursos ?? []).filter((c) => c.state === 'in_progress');
  const terminados = (cursos ?? []).filter((c) => c.state === 'completed');
  const sinEmpezar = (cursos ?? []).filter((c) => c.state === 'not_started');

  const hayCursos = (cursos ?? []).length > 0;
  const hayAudios = audios.length > 0;
  const cargando = cursos === null;
  const estado = cargando
    ? 'loading'
    : pestana === 0
    ? hayCursos
      ? 'content'
      : 'empty'
    : hayAudios
    ? 'content'
    : 'empty';

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="Mi Biblioteca" />
      <View style={styles.header}>
        <SegmentedControl
          options={['Mis Cursos', 'Mis Audios']}
          selectedIndex={pestana}
          onChange={setPestana}
        />
      </View>

      <StateView
        state={estado}
        title={pestana === 0 ? 'Todavía no tienes cursos' : 'Historial de audios vacío'}
        description={
          pestana === 0
            ? fallo ?? 'Cuando empieces un curso aparecerá aquí con tu avance.'
            : 'Los audios que escuches se guardarán aquí.'
        }
        icon={pestana === 0 ? 'book' : 'headphones'}
      >
        <ScrollView contentContainerStyle={styles.list}>
          {pestana === 0 ? (
            <>
              <Grupo titulo="Continúa aprendiendo" cursos={enCurso} router={router} />
              <Grupo titulo="Sin empezar" cursos={sinEmpezar} router={router} />
              <Grupo titulo="Completados" cursos={terminados} router={router} />
            </>
          ) : (
            audios.map((audio) => (
              <ListRow
                key={audio.id}
                title={audio.title}
                subtitle={audio.subtitle}
                leftIcon="headphones"
                rightIcon="play"
                onPress={() => router.push(`/audio/${audio.id}` as any)}
              />
            ))
          )}
        </ScrollView>
      </StateView>
    </View>
  );
}

function Grupo({
  titulo,
  cursos,
  router,
}: {
  titulo: string;
  cursos: MyCourse[];
  router: ReturnType<typeof useRouter>;
}) {
  const { colors } = useAppTheme();
  if (cursos.length === 0) return null;
  return (
    <View style={styles.grupo}>
      <Text style={[styles.tituloDeGrupo, { color: colors.textMuted }]}>{titulo}</Text>
      {cursos.map((curso) => (
        <ListRow
          key={curso.id}
          title={curso.title}
          subtitle={subtituloDe(curso)}
          leftIcon={curso.state === 'completed' ? 'check-circle' : 'play-circle'}
          rightIcon="chevron-right"
          // Siempre al curso real. Continuar desde la leccion pendiente vive
          // dentro, junto al temario, que es donde se ve por que se continua.
          onPress={() => router.push(`/course/${curso.id}` as never)}
        />
      ))}
    </View>
  );
}

/** Lo que de verdad se sabe del avance, sin adornos. */
function subtituloDe(curso: MyCourse): string {
  if (curso.lessonsTotal === 0) return 'Sin contenido todavía';
  if (curso.state === 'completed') return `Completado · ${curso.lessonsTotal} lecciones`;
  if (curso.state === 'in_progress') {
    return `${curso.progressPercent}% · ${curso.lessonsCompleted} de ${curso.lessonsTotal} lecciones`;
  }
  return `${curso.lessonsTotal} lecciones`;
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
    paddingBottom: spacing.xl,
  },
  grupo: { marginBottom: spacing.lg },
  tituloDeGrupo: {
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
});
