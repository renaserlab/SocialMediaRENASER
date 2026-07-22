import React, { useCallback, useEffect, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { Feather } from '@expo/vector-icons';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { ListRow } from '@/components/ListRow';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import {
  CourseContentRepository,
  type LessonResourceFile,
} from '@/repositories/CourseContentRepository';
import { uploadCourseMedia } from '@/services/storage';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  lessonId: string;
  /** Solo la administracion sube y borra; la RLS lo impone de verdad. */
  canEdit: boolean;
};

function formatSize(bytes: number | null): string {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Material descargable de la leccion.
 *
 * A diferencia de los testimonios, aqui la descarga SI se quiere: son
 * documentos del curso pensados para llevarselos.
 */
export function LessonResources({ lessonId, canEdit }: Props) {
  const { colors } = useAppTheme();
  const [items, setItems] = useState<LessonResourceFile[]>([]);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await CourseContentRepository.listResources(lessonId));
    } catch (error) {
      console.warn('[leccion] no se pudieron cargar los documentos:', error);
      setItems([]);
    }
  }, [lessonId]);

  useEffect(() => {
    void load();
  }, [load]);

  const choose = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled) return;
      const asset = result.assets?.[0];
      if (!asset) return;
      setFile(asset);
      // El nombre del archivo es un titulo razonable por defecto.
      if (!title.trim()) setTitle(asset.name.replace(/\.[^.]+$/, ''));
    } catch {
      notify('No se pudo abrir el selector', 'Revisa los permisos e inténtalo de nuevo.');
    }
  };

  const save = async () => {
    if (!title.trim() || !file) return;
    setSaving(true);
    try {
      const storagePath = await uploadCourseMedia({
        uri: file.uri,
        // El bucket admite documentos; `kind` solo decide la extension por
        // defecto, y el nombre real ya trae la suya.
        kind: 'image',
        mimeType: file.mimeType ?? null,
        name: file.name,
      });
      await CourseContentRepository.addResource({
        lessonId,
        title: title.trim(),
        storagePath,
        mimeType: file.mimeType ?? null,
        sizeBytes: file.size ?? null,
        sortOrder: items.length,
      });
      toast('Documento añadido');
      setTitle('');
      setFile(null);
      setAdding(false);
      await load();
    } catch (error) {
      notify('No se pudo subir', error instanceof Error ? error.message : 'Inténtalo de nuevo.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (item: LessonResourceFile) => {
    const accepted = await confirm({
      title: 'Eliminar documento',
      message: `Se quitará "${item.title}" de esta lección.`,
      confirmLabel: 'Eliminar',
      destructive: true,
    });
    if (!accepted) return;
    try {
      await CourseContentRepository.removeResource(item.id);
      toast('Documento eliminado');
      await load();
    } catch {
      notify('No se pudo eliminar', 'Inténtalo de nuevo.');
    }
  };

  const download = async (item: LessonResourceFile) => {
    if (!item.url) {
      notify('No disponible', 'No se pudo preparar la descarga. Inténtalo de nuevo.');
      return;
    }
    try {
      // En web se abre en una pestaña (el navegador decide si ver o guardar);
      // en movil lo resuelve la aplicacion asociada al tipo de archivo.
      if (Platform.OS === 'web') window.open(item.url, '_blank', 'noopener');
      else await Linking.openURL(item.url);
    } catch {
      notify('No se pudo abrir', 'Inténtalo de nuevo.');
    }
  };

  // Sin documentos y sin permiso para subirlos, la seccion sobra.
  if (items.length === 0 && !canEdit) return null;

  return (
    <View>
      <View style={styles.header}>
        <Text variant="body" weight="700" style={{ flex: 1 }}>
          Recursos del Curso
        </Text>
        {canEdit ? (
          <Pressable
            onPress={() => setAdding(true)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Añadir documento"
          >
            <Feather name="plus" size={18} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>

      {items.length === 0 ? (
        <Text variant="secondary" color={colors.textMuted}>
          Aún no hay material para descargar.
        </Text>
      ) : (
        items.map((item) => (
          <ListRow
            key={item.id}
            title={item.title}
            subtitle={[item.mimeType?.split('/').pop()?.toUpperCase(), formatSize(item.sizeBytes)]
              .filter(Boolean)
              .join(' · ')}
            leftIcon="file-text"
            rightIcon={canEdit ? 'trash-2' : 'download'}
            onPress={() => (canEdit ? void remove(item) : void download(item))}
          />
        ))
      )}

      <BottomSheet
        visible={adding}
        onClose={() => {
          setAdding(false);
          setTitle('');
          setFile(null);
        }}
      >
        <Text style={styles.sheetTitle} color={colors.text}>
          Nuevo documento
        </Text>
        <Input
          value={title}
          onChangeText={setTitle}
          placeholder="Nombre visible del documento"
          placeholderTextColor={colors.textMuted}
          style={{ color: colors.text }}
        />
        <ListRow
          title={file ? file.name : 'Elegir archivo'}
          subtitle={file ? formatSize(file.size ?? null) : 'PDF, plantillas, imágenes…'}
          leftIcon="paperclip"
          onPress={() => void choose()}
        />
        <Button
          label="Subir documento"
          onPress={() => void save()}
          loading={saving}
          disabled={!title.trim() || !file}
          style={styles.submit}
        />
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.sm },
  sheetTitle: {
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.md,
  },
  submit: { marginTop: spacing.lg },
});
