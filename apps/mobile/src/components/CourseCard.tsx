import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import Feather from '@expo/vector-icons/Feather';

import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { assets } from '@/data/assets';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Course } from '@/types';
import { useTranslation } from '@/i18n/useTranslation';

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
  const { t } = useTranslation();
  const { colors } = useAppTheme();

  return (
    <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <Pulsable
        onPress={onPress}
        style={StyleSheet.absoluteFill}
        accessibilityRole="button"
        accessibilityLabel={`Ver ${course.title}`}
      />

      {/* Portada del curso; el asset local solo mientras no tenga una propia. */}
      <ExpoImage
        source={course.coverUrl ? { uri: course.coverUrl } : assets.course}
        style={styles.cover}
        contentFit="cover"
        transition={150}
        pointerEvents="none"
      />

      <View style={styles.row} pointerEvents="box-none">
        <View style={styles.info} pointerEvents="none">
          <Text variant="body" weight="700" numberOfLines={2}>
            {course.title}
          </Text>
          <Text variant="secondary" color={colors.textMuted} numberOfLines={1}>
            {course.subtitle || t('course.viewProgram')}
          </Text>
        </View>

        {onEdit ? (
          <Pulsable
            onPress={onEdit}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={`Editar ${course.title}`}
            style={styles.edit}
          >
            <Feather name="edit-2" size={16} color={colors.textMuted} />
          </Pulsable>
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
    overflow: 'hidden',
    marginBottom: spacing.md,
  },
  cover: { width: '100%', height: 150 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md },
  info: { flex: 1, gap: 2 },
  edit: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
});
