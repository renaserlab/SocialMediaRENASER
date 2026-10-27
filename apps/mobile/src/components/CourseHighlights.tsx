import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { InlineError } from '@/components/InlineError';
import { StateView } from '@/components/StateView';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { toast } from '@/lib/toast';
import { CourseContentRepository } from '@/repositories/CourseContentRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

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
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const [items, setItems] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * No se pudo leer la lista.
   *
   * ES DISTINTO DE «no hay puntos», y antes no lo era: el `catch` dejaba la
   * lista vacia y la pantalla pintaba «este curso todavia no tiene puntos
   * destacados», que es una afirmacion sobre el curso. Un fallo de red se leia
   * como una carencia del contenido, y encima sin forma de reintentar.
   */
  const [falloAlCargar, setFalloAlCargar] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await CourseContentRepository.getHighlights(courseId));
      setFalloAlCargar(false);
    } catch (error) {
      console.warn('[curso] no se pudieron cargar los puntos:', error);
      setItems([]);
      setFalloAlCargar(true);
    }
  }, [courseId]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = () => {
    // Siempre una linea vacia al final para poder seguir escribiendo.
    setDraft(items.length > 0 ? [...items, ''] : ['']);
    setError(null);
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
    setError(null);
    try {
      await CourseContentRepository.setHighlights(courseId, clean);
      setItems(clean);
      // Cerrar antes del aviso: la hoja es un Modal y en iOS taparia el toast.
      setEditing(false);
      toast(t('highlights.updated'));
    } catch (failure) {
      // La hoja sigue abierta: el error se cuenta dentro de ella.
      setError(
        failure instanceof Error ? failure.message : t('highlights.saveFailed'),
      );
    } finally {
      setSaving(false);
    }
  };

  // Sin puntos y sin permiso para anadirlos, la seccion sobra.
  // Con el fallo puesto SI se pinta aunque no se pueda editar: callarse seria
  // volver a confundir «no hay» con «no se pudo leer».
  if (items.length === 0 && !canEdit && !falloAlCargar) return null;

  return (
    <View>
      <View style={styles.header}>
        <Text variant="body" weight="900" style={{ flex: 1 }}>
          {t('highlights.title')}
        </Text>
        {canEdit ? (
          <Pressable
            onPress={open}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t('highlights.edit')}
          >
            <Feather name="edit-2" size={16} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>

      {falloAlCargar ? (
        <StateView
          state="error"
          description={t('highlights.loadFailed')}
          onRetry={() => void load()}
        />
      ) : items.length === 0 ? (
        <Text variant="secondary" color={colors.textMuted} style={styles.empty}>
          {t('highlights.empty')}
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
          {t('highlights.title')}
        </Text>
        {draft.map((value, index) => (
          <Input
            key={index}
            value={value}
            onChangeText={(v) => change(index, v)}
            placeholder={
              index === draft.length - 1 ? t('highlights.addAnother') : t('highlights.point')
            }
            placeholderTextColor={colors.textMuted}
            style={{ color: colors.text }}
            containerStyle={styles.input}
          />
        ))}
        <Text variant="secondary" color={colors.textMuted} style={styles.hint}>
          {t('highlights.blankToDelete')}
        </Text>
        <InlineError message={error} />
        <Button
          label={t('common.save')}
          onPress={() => void save()}
          loading={saving}
          style={styles.submit}
        />
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
