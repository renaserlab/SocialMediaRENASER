import React, { useCallback, useEffect, useRef, useState } from 'react';
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
 *
 * «MIS AUDIOS» SALE VACIA A PROPOSITO. Habia dos audios escritos a mano aqui
 * —«Tu enfoque de esta semana» y «El poder de la disciplina diaria»— que
 * ademas abrian los DOS el mismo contenido: iban a `/audio/{id}` y esa
 * pantalla ignora el id, siempre carga el audio privado vigente. No existe un
 * historial de escucha en ningun sitio: no hay tabla ni endpoint que registre
 * lo que alguien ha oido, y `/posts?media=audio` lista los audios de un
 * CREADOR, que no es lo mismo. Hasta que esa fuente exista la pestaña dice que
 * esta vacia, que es la verdad. No se vuelve a rellenar a mano.
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

  /*
    Al volver de un curso el progreso ha cambiado: se vuelve a pedir en vez de
    ensenar el porcentaje con el que se salio.

    EL PRIMER FOCO SE SALTA A PROPOSITO. `useFocusEffect` tambien dispara al
    MONTAR, asi que junto con el efecto de arriba la biblioteca pedia
    `/catalog/courses/mine` DOS veces en cada apertura, siempre, y la primera
    respuesta se tiraba. Es el mismo fallo que ya estaba resuelto en
    `ProfileSection` (ver el comentario de `yaSeEnfoco` alli); aqui nunca se
    aplico. Al montar ya carga el efecto de arriba; esto solo tiene que
    ocuparse de las VUELTAS.
  */
  const yaSeEnfoco = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!yaSeEnfoco.current) {
        yaSeEnfoco.current = true;
        return;
      }
      void cargar();
    }, [cargar]),
  );

  const enCurso = (cursos ?? []).filter((c) => c.state === 'in_progress');
  const terminados = (cursos ?? []).filter((c) => c.state === 'completed');
  const sinEmpezar = (cursos ?? []).filter((c) => c.state === 'not_started');

  const hayCursos = (cursos ?? []).length > 0;
  // La pestaña de audios no espera a nada: no hay nada que pedir.
  const estado =
    pestana === 1 ? 'empty' : cursos === null ? 'loading' : hayCursos ? 'content' : 'empty';

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
          <Grupo titulo="Continúa aprendiendo" cursos={enCurso} router={router} />
          <Grupo titulo="Sin empezar" cursos={sinEmpezar} router={router} />
          <Grupo titulo="Completados" cursos={terminados} router={router} />
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
