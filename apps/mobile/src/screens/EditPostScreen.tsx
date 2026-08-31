import React, { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { VideoPlayer } from '@/components/VideoPlayer';
import { SelectorDeCategoria } from '@/components/SelectorDeCategoria';
import { SelectorDeTemas } from '@/components/SelectorDeTemas';
import { PostRepository } from '@/repositories/PostRepository';
import {
  pickAudio,
  pickImage,
  pickVideo,
  uploadPostMedia,
  type PickedMedia,
  type UploadProgress,
} from '@/services/storage';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Post } from '@/types';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * Edicion de una publicacion propia: texto y adjunto.
 *
 * El adjunto se trata en tres estados para no perder informacion: `null` =
 * conservar el que ya tiene, `'remove'` = quitarlo, y un `PickedMedia` =
 * reemplazarlo. Enviar siempre el medio obligaria a resubirlo sin necesidad.
 */
type MediaChange = null | 'remove' | PickedMedia;

export function EditPostScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const posts = useAppStore((state) => state.posts);
  const setPosts = useAppStore((state) => state.setPosts);
  const currentUserId = useAppStore((state) => state.user?.id);

  const [post, setPost] = useState<Post | null>(null);
  const [text, setText] = useState('');
  const [media, setMedia] = useState<MediaChange>(null);
  /** Categoría, solo relevante en los audios (episodios del podcast). */
  const [category, setCategory] = useState<string | null>(null);
  /** De qué trata: taxonomía común, la misma que eligen las personas. */
  const [topicIds, setTopicIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [phase, setPhase] = useState<UploadProgress['phase'] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    // Si viene del feed ya está en memoria; si se abre directo, se pide.
    const cached = posts.find((p) => p.id === id);
    if (cached) {
      setPost(cached);
      setText(cached.body);
      setCategory(cached.category ?? null);
      setTopicIds(cached.topicIds ?? []);
      setLoading(false);
      return;
    }
    let alive = true;
    /*
      Se pide la publicacion por su identificador.

      Antes se descargaban las 60 ultimas del autor para buscar una: pesaba de
      mas y, sobre todo, quien tuviera mas de sesenta publicaciones no podia
      editar las antiguas —la pantalla se quedaba vacia sin decir por que—.
    */
    PostRepository.getById(id, currentUserId)
      .then((found) => {
        if (!alive) return;
        setPost(found);
        setText(found.body);
        setCategory(found.category ?? null);
        setTopicIds(found.topicIds ?? []);
      })
      .catch((error) => {
        console.warn('[editar publicacion] no se pudo cargar', error);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id, posts, currentUserId]);

  const choose = async (kind: 'image' | 'video' | 'audio') => {
    try {
      const picked =
        kind === 'image' ? await pickImage() : kind === 'video' ? await pickVideo() : await pickAudio();
      if (picked) setMedia(picked);
    } catch {
      setError(t('editPost.pickerFailed'));
    }
  };

  const save = async () => {
    if (!post) return;
    if (!text.trim()) {
      setError(t('editPost.emptyPost'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const changes: {
        body?: string;
        media?: Awaited<ReturnType<typeof uploadPostMedia>>[];
        category?: string | null;
        topicIds?: string[];
      } = {};
      if (text.trim() !== post.body) changes.body = text.trim();
      if ((category ?? null) !== (post.category ?? null)) changes.category = category;
      /*
        Los temas solo viajan si cambiaron. Es una distincion con consecuencias:
        el campo AUSENTE significa «no los toques» y `[]` significa «quitalos
        todos», asi que mandarlos siempre borraria los de una publicacion cuyo
        selector ni siquiera llego a pintarse (la taxonomia se carga aparte y
        puede fallar).
      */
      const temasPrevios = post.topicIds ?? [];
      const temasCambiaron =
        topicIds.length !== temasPrevios.length ||
        topicIds.some((id) => !temasPrevios.includes(id));
      if (temasCambiaron) changes.topicIds = topicIds;
      if (media === 'remove') {
        changes.media = [];
      } else if (media) {
        const uploaded = await uploadPostMedia(media, (p) => setPhase(p.phase));
        changes.media = [uploaded];
      }

      if (Object.keys(changes).length === 0) {
        router.back();
        return;
      }

      const updated = await PostRepository.updatePost(post.id, changes, currentUserId);
      // Refleja el cambio en el feed sin tener que recargarlo entero.
      setPosts(posts.map((p) => (p.id === updated.id ? updated : p)));
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('editPost.saveFailed'));
    } finally {
      setSaving(false);
      setPhase(null);
    }
  };

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title={t('post.editTitle')} back />
        <StateView state="loading" />
      </View>
    );
  }

  if (!post) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title={t('post.editTitle')} back />
        <StateView state="empty" title={t('editPost.notFound')} />
      </View>
    );
  }

  const keepsCurrentMedia = media === null && (post.mediaUrl || post.imageKey);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title={t('post.editTitle')} back />
      <SinTecladoDelante>
        <AppScreen contentStyle={{ padding: spacing.lg, paddingBottom: 100 }}>
          <View style={[styles.editor, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <TextInput
              value={text}
              onChangeText={setText}
              multiline
              maxLength={700}
              textAlignVertical="top"
              style={[styles.input, { color: colors.text }]}
              accessibilityLabel={t('create.postDescription')}
            />
            <View style={styles.mediaRow}>
              <Pressable
                onPress={() => choose('image')}
                hitSlop={8}
                accessibilityLabel={t('editPost.swapImage')}
              >
                <Feather name="image" size={20} color={colors.textMuted} />
              </Pressable>
              <Pressable
                onPress={() => choose('video')}
                hitSlop={8}
                accessibilityLabel={t('editPost.swapVideo')}
              >
                <Feather name="video" size={20} color={colors.textMuted} />
              </Pressable>
              <Pressable
                onPress={() => choose('audio')}
                hitSlop={8}
                accessibilityLabel={t('editPost.swapAudio')}
              >
                <Feather name="mic" size={20} color={colors.textMuted} />
              </Pressable>
            </View>
          </View>

          {/* Adjunto actual o el nuevo elegido */}
          {media && media !== 'remove' ? (
            <View style={styles.previewWrap}>
              {media.kind === 'image' ? (
                <Image source={{ uri: media.uri }} style={styles.preview} resizeMode="cover" />
              ) : media.kind === 'video' ? (
                <VideoPlayer uri={media.uri} style={styles.preview} nativeControls muted />
              ) : (
                <View style={[styles.audioRow, { borderColor: colors.border }]}>
                  <Feather name="music" size={20} color={colors.text} />
                  <Text style={{ color: colors.text }}>{media.name ?? t('editPost.audioPicked')}</Text>
                </View>
              )}
              <Pressable
                onPress={() => setMedia(null)}
                style={styles.removeBtn}
                accessibilityLabel={t('editPost.discardChange')}
              >
                <Feather name="x" size={16} color="#FFFFFF" />
              </Pressable>
            </View>
          ) : keepsCurrentMedia ? (
            <View style={styles.previewWrap}>
              {post.mediaType === 'video' && post.mediaUrl ? (
                <VideoPlayer uri={post.mediaUrl} style={styles.preview} nativeControls />
              ) : post.mediaUrl ? (
                <Image source={{ uri: post.mediaUrl }} style={styles.preview} resizeMode="cover" />
              ) : null}
              <Pressable
                onPress={() => setMedia('remove')}
                style={styles.removeBtn}
                accessibilityLabel={t('editPost.removeAttachment')}
              >
                <Feather name="trash-2" size={15} color="#FFFFFF" />
              </Pressable>
            </View>
          ) : media === 'remove' ? (
            <Text style={[styles.removedNote, { color: colors.textMuted }]}>
              {t('editPost.attachmentWillGo')}
            </Text>
          ) : null}

          <View style={styles.temas}>
            <SelectorDeTemas seleccionados={topicIds} alCambiar={setTopicIds} variante="clara" />
          </View>

          {/* Los audios son episodios del podcast: su categoría alimenta los
              filtros de esa sección. */}
          {post.mediaType === 'audio' ? (
            <View style={styles.categories}>
              <SelectorDeCategoria
                ownerId={post.authorId}
                valor={category}
                alCambiar={setCategory}
              />
            </View>
          ) : null}

          {error ? (
            <View style={[styles.errorBox, { borderColor: colors.danger, backgroundColor: colors.surfaceAlt }]}>
              <Feather name="alert-triangle" size={18} color={colors.danger} />
              <Text style={{ color: colors.danger, flex: 1, fontSize: 13 }}>{error}</Text>
            </View>
          ) : null}

          <Button
            label={
              phase === 'compressing'
                ? t('editPost.optimizing')
                : phase === 'uploading'
                  ? t('editPost.uploading')
                  : t('common.saveChanges')
            }
            onPress={() => void save()}
            loading={saving}
            disabled={!text.trim()}
          />
        </AppScreen>
      </SinTecladoDelante>
    </View>
  );
}

const styles = StyleSheet.create({
  editor: { minHeight: 200, borderWidth: 1, borderRadius: radius.xl, padding: spacing.lg, marginBottom: spacing.lg },
  input: { flex: 1, fontSize: 16, lineHeight: 24, minHeight: 120 },
  mediaRow: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.md },
  previewWrap: { position: 'relative', marginBottom: spacing.lg },
  preview: { width: '100%', height: 200, borderRadius: radius.lg, overflow: 'hidden' },
  audioRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg, minHeight: 72,
  },
  removeBtn: {
    position: 'absolute', top: spacing.sm, right: spacing.sm,
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center',
  },
  temas: { marginBottom: spacing.lg },
  categories: { gap: spacing.sm, marginBottom: spacing.lg },
  removedNote: { fontSize: 13, marginBottom: spacing.lg },
  errorBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md,
    borderWidth: 1, borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.lg,
  },
});
