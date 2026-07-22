import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Course } from '@/types';

type Props = {
  course: Course;
  onPress: () => void;
  /** Solo el administrador lo recibe; abre la edicion del curso. */
  onEdit?: () => void;
};

/**
 * Fila de un curso en el perfil.
 *
 * Misma estructura que EventCard: la zona pulsable va DETRAS del contenido y el
 * lapiz es su hermano, no un boton anidado. En web cada Pressable es un
 * <button> y anidarlos rompe la hidratacion.
 */
export function CourseCard({ course, onPress, onEdit }: Props) {
  const { colors } = useAppTheme();

  return (
    <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <Pressable
        onPress={onPress}
        style={StyleSheet.absoluteFill}
        accessibilityRole="button"
        accessibilityLabel={`Ver ${course.title}`}
      />

      <View style={styles.row} pointerEvents="box-none">
        <View pointerEvents="none">
          <Feather name="book" size={22} color={colors.text} />
        </View>

        <View style={styles.info} pointerEvents="none">
          <Text variant="body" weight="700" numberOfLines={2}>
            {course.title}
          </Text>
          <Text variant="secondary" color={colors.textMuted} numberOfLines={1}>
            {course.subtitle || 'Ver programa'}
          </Text>
        </View>

        {onEdit ? (
          <Pressable
            onPress={onEdit}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={`Editar ${course.title}`}
            style={styles.edit}
          >
            <Feather name="edit-2" size={16} color={colors.textMuted} />
          </Pressable>
        ) : (
          <View pointerEvents="none">
            <Feather name="chevron-right" size={18} color={colors.textMuted} />
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  info: { flex: 1, gap: 2 },
  edit: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
});
