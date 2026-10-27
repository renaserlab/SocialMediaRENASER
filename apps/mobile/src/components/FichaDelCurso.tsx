import React from 'react';
import { StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { SectionTitle } from '@/components/SectionTitle';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Course } from '@/types';

/**
 * Lo que el curso promete: duración, idioma, nivel, aprendizajes, para quién es
 * y qué hace falta.
 *
 * Cada bloque aparece SOLO si el servidor lo manda. Un curso sin nivel no
 * enseña «nivel: —», y ninguno enseña valoración ni número de alumnos: esos
 * datos no existen en el modelo.
 */

function duracionLegible(segundos: number, t: (k: never) => string): string {
  const horas = Math.floor(segundos / 3600);
  const minutos = Math.round((segundos % 3600) / 60);
  if (horas > 0 && minutos > 0) return `${horas} h ${minutos} min`;
  if (horas > 0) return `${horas} h`;
  return `${minutos} min`;
}

export function FichaDelCurso({
  course,
  duracionSegundos,
}: {
  course: Course;
  /** La suma la hace el SERVIDOR; aquí solo se formatea. */
  duracionSegundos: number;
}) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();

  const datos: { icono: keyof typeof Feather.glyphMap; texto: string }[] = [];
  if (duracionSegundos > 0) {
    datos.push({ icono: 'clock', texto: duracionLegible(duracionSegundos, t as never) });
  }
  if (course.level) {
    datos.push({
      icono: 'bar-chart-2',
      texto: t(`cursos.nivel.${course.level}` as 'cursos.nivel.beginner'),
    });
  }
  if (course.language) {
    datos.push({ icono: 'globe', texto: course.language.toUpperCase() });
  }

  const listas: { titulo: string; puntos: string[] }[] = [
    { titulo: t('ficha.aprenderas'), puntos: course.highlights ?? [] },
    { titulo: t('ficha.paraQuien'), puntos: course.targetAudience ?? [] },
    { titulo: t('ficha.requisitos'), puntos: course.prerequisites ?? [] },
  ].filter((l) => l.puntos.length > 0);

  if (datos.length === 0 && listas.length === 0) return null;

  return (
    <View style={styles.bloque}>
      {datos.length > 0 ? (
        <View style={styles.datos}>
          {datos.map((dato) => (
            <View key={dato.texto} style={styles.dato}>
              <Feather name={dato.icono} size={14} color={colors.textMuted} />
              <Text style={[styles.textoDeDato, { color: colors.textMuted }]}>
                {dato.texto}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {listas.map((lista) => (
        <View key={lista.titulo} style={styles.lista}>
          <SectionTitle title={lista.titulo} />
          {lista.puntos.map((punto) => (
            <View key={punto} style={styles.punto}>
              <Feather name="check" size={15} color={colors.text} />
              <Text style={[styles.textoDePunto, { color: colors.text }]}>{punto}</Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bloque: { gap: spacing.md },
  datos: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  dato: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  textoDeDato: { fontSize: 13 },
  lista: { gap: 6 },
  punto: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  textoDePunto: { flex: 1, fontSize: 14, lineHeight: 20 },
});
