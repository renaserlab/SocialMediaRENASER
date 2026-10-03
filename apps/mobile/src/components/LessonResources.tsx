import React, { useCallback, useEffect, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { Feather } from '@expo/vector-icons';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { InlineError } from '@/components/InlineError';
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
import { useTranslation } from '@/i18n/useTranslation';

type Props = {
  lessonId: string;
  /** El curso al que pertenece: la ruta de subida lo necesita para demostrar
   *  de quien es el material (migracion 0028). */
  courseId: string;
  /** El autor del curso o la administracion; la RLS lo impone de verdad. */
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
export function LessonResources({ lessonId, courseId, canEdit }: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const [items, setItems] = useState<LessonResourceFile[]>([]);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [saving, setSaving] = useState(false);
  // Lo que falla con la hoja abierta se cuenta DENTRO de la hoja: en iOS un
  // dialogo no puede presentarse encima de un Modal y no se veria.
  const [error, setError] = useState<string | null>(null);

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
      setError(null);
      // El nombre del archivo es un titulo razonable por defecto.
      if (!title.trim()) setTitle(asset.name.replace(/\.[^.]+$/, ''));
    } catch {
      setError(t('resources.pickerFailed'));
    }
  };

  const save = async () => {
    if (!title.trim() || !file) return;
    setSaving(true);
    setError(null);
    try {
      const storagePath = await uploadCourseMedia(
        {
          uri: file.uri,
          // El bucket admite documentos; `kind` solo decide la extension por
          // defecto, y el nombre real ya trae la suya.
          kind: 'image',
          mimeType: file.mimeType ?? null,
          name: file.name,
        },
        courseId,
      );
      await CourseContentRepository.addResource({
        lessonId,
        title: title.trim(),
        storagePath,
        mimeType: file.mimeType ?? null,
        sizeBytes: file.size ?? null,
        sortOrder: items.length,
      });
      setTitle('');
      setFile(null);
      // Cerrar antes del aviso: mientras la hoja siga montada, en iOS tapa el
      // toast igual que taparia un dialogo.
      setAdding(false);
      toast(t('resources.added'));
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('resources.uploadFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (item: LessonResourceFile) => {
    const accepted = await confirm({
      title: t('resources.deleteTitle'),
      message: `Se quitará "${item.title}" de esta lección.`,
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (!accepted) return;
    try {
      await CourseContentRepository.removeResource(item.id);
      toast('Documento eliminado');
      await load();
    } catch {
      notify(t('common.deleteFailed'), t('common.tryAgain'));
    }
  };

  const download = async (item: LessonResourceFile) => {
    /*
      La firma se pide AHORA, no al entrar en la leccion.

      El bucket `course-media` es privado y sigue siendolo: lo que cambia es
      CUANDO se pide el permiso de lectura. Firmar los veinte documentos al
      abrir la pantalla gastaba conexion en el peor momento —mientras arranca el
      video— y encima entregaba firmas que podian caducar antes de que alguien
      pulsara.
    */
    let url = item.url;
    if (!url) {
      try {
        url = (await CourseContentRepository.firmarRecurso(item.storagePath)) ?? undefined;
      } catch {
        url = undefined;
      }
    }
    if (!url) {
      notify(t('resources.unavailable'), t('resources.downloadFailed'));
      return;
    }
    try {
      // En web se abre en una pestaña (el navegador decide si ver o guardar);
      // en movil lo resuelve la aplicacion asociada al tipo de archivo.
      if (Platform.OS === 'web') window.open(url, '_blank', 'noopener');
      else await Linking.openURL(url);
    } catch {
      notify(t('common.couldNotOpen'), t('common.tryAgain'));
    }
  };

  /*
    SIN DOCUMENTOS TAMBIEN SE PINTA. Aqui habia un `return null` para el alumno
    («sin documentos, la seccion sobra»), de cuando esto iba apilado debajo de
    la leccion. Ahora es la pestaña «Recursos» entera: devolver nada la dejaba
    en blanco, y una pestaña en blanco no se distingue de una que no ha
    cargado. El texto de «todavia no hay material» ya existia mas abajo.
  */
  return (
    <View>
      <View style={styles.header}>
        <Text variant="body" weight="700" style={{ flex: 1 }}>
          {t('resources.title')}
        </Text>
        {canEdit ? (
          <Pressable
            onPress={() => setAdding(true)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t('resources.add')}
          >
            <Feather name="plus" size={18} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>

      {items.length === 0 ? (
        <Text variant="secondary" color={colors.textMuted}>
          {t('resources.empty')}
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
          setError(null);
        }}
      >
        <Text style={styles.sheetTitle} color={colors.text}>
          {t('resources.newDocument')}
        </Text>
        <Input
          value={title}
          onChangeText={setTitle}
          placeholder={t('resources.namePlaceholder')}
          placeholderTextColor={colors.textMuted}
          style={{ color: colors.text }}
        />
        <ListRow
          title={file ? file.name : t('resources.pickFile')}
          subtitle={file ? formatSize(file.size ?? null) : t('resources.hint')}
          leftIcon="paperclip"
          onPress={() => void choose()}
        />
        <InlineError message={error} />
        <Button
          label={t('resources.upload')}
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
