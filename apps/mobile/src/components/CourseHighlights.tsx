import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import { CourseContentRepository } from '@/repositories/CourseContentRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  courseId: string;
  /** Solo la administracion edita; la RLS lo impone de verdad. */
  canEdit: boolean;
};

/**
 * "Lo que vas a desarrollar".
 *
 * Antes era una lista fija en el codigo, identica para todos los cursos. Ahora
 * vive en `courses.highlights` y se edita desde la propia pantalla.
 */
export function CourseHighlights({ courseId, canEdit }: Props) {
  const { colors } = useAppTheme();
  const [items, setItems] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await CourseContentRepository.getHighlights(courseId));
    } catch (error) {
      console.warn('[curso] no se pudieron cargar los puntos:', error);
      setItems([]);
    }
  }, [courseId]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = () => {
    // Siempre una linea vacia al final para poder seguir escribiendo.
    setDraft(items.length > 0 ? [...items, ''] : ['']);
    setEditing(true);
  };

  const change = (index: number, value: string) => {
    setDraft((prev) => {
      const next = [...prev];
      next[index] = value;
      // Al escribir en la ultima, se anade otra vacia debajo.
      if (index === next.length - 1 && value.trim()) next.push('');
      return next;
    });
  };

  const save = async () => {
    const clean = draft.map((v) => v.trim()).filter(Boolean);
    setSaving(true);
    try {
      await CourseContentRepository.setHighlights(courseId, clean);
      setItems(clean);
      setEditing(false);
      toast('Puntos actualizados');
    } catch (error) {
      notify('No se pudo guardar', error instanceof Error ? error.message : 'Inténtalo de nuevo.');
    } finally {
      setSaving(false);
    }
  };

  // Sin puntos y sin permiso para anadirlos, la seccion sobra.
  if (items.length === 0 && !canEdit) return null;

  return (
    <View>
      <View style={styles.header}>
        <Text variant="body" weight="900" style={{ flex: 1 }}>
          Lo que vas a desarrollar
        </Text>
        {canEdit ? (
          <Pressable
            onPress={open}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Editar lo que vas a desarrollar"
          >
            <Feather name="edit-2" size={16} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>

      {items.length === 0 ? (
        <Text variant="secondary" color={colors.textMuted} style={styles.empty}>
          Añade los puntos que se llevará quien haga el curso.
        </Text>
      ) : (
        items.map((item, index) => (
          <View key={`${item}-${index}`} style={styles.row}>
            <Feather name="check" size={20} color={colors.success} style={{ marginTop: 2 }} />
            <Text variant="body" style={{ flex: 1 }}>
              {item}
            </Text>
          </View>
        ))
      )}

      <BottomSheet visible={editing} onClose={() => setEditing(false)}>
        <Text style={styles.sheetTitle} color={colors.text}>
          Lo que vas a desarrollar
        </Text>
        {draft.map((value, index) => (
          <Input
            key={index}
            value={value}
            onChangeText={(v) => change(index, v)}
            placeholder={index === draft.length - 1 ? 'Añadir otro punto…' : 'Punto'}
            placeholderTextColor={colors.textMuted}
            style={{ color: colors.text }}
            containerStyle={styles.input}
          />
        ))}
        <Text variant="secondary" color={colors.textMuted} style={styles.hint}>
          Deja un punto en blanco para eliminarlo.
        </Text>
        <Button label="Guardar" onPress={() => void save()} loading={saving} style={styles.submit} />
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.lg },
  empty: { marginBottom: spacing.md },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, marginBottom: spacing.md },
  sheetTitle: {
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.md,
  },
  input: { marginBottom: spacing.sm },
  hint: { marginTop: spacing.xs },
  submit: { marginTop: spacing.lg },
});
