import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { useKeyboardOffset } from '@/hooks/useKeyboardOffset';
import { ListRow } from '@/components/ListRow';
import { PostCard } from '@/components/PostCard';
import { StateView } from '@/components/StateView';
import { AuthRepository } from '@/repositories/AuthRepository';
import { PostRepository } from '@/repositories/PostRepository';
import { useAppStore } from '@/store/useAppStore';
import type { Post } from '@/types';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function PostDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useAppTheme();
  const router = useRouter();
  const keyboardOffset = useKeyboardOffset();

  const enFeed = useAppStore((state) => state.posts.find((p) => p.id === id));
  const currentUserId = useAppStore((state) => state.user?.id ?? null);

  /*
    Si la publicacion no esta en el feed cargado, se pide al servidor.

    Antes solo se miraba `state.posts`, la lista que hay en memoria. Al abrir un
    enlace compartido, al recargar la pagina en el navegador o al entrar desde
    un aviso, esa lista todavia esta vacia, y una publicacion que existe se
    anunciaba como «no disponible, es posible que se haya eliminado». Tambien
    pasaba con cualquier publicacion antigua que quedara fuera de las paginas
    ya descargadas.
  */
  const [pedida, setPedida] = useState<Post | null>(null);
  const [estado, setEstado] = useState<'cargando' | 'error' | 'ausente' | 'listo'>('cargando');
  /*
    Reintento explicito. El estado NO puede ir en las dependencias del efecto:
    el propio efecto lo cambia, asi que se volveria a disparar solo y quedaria
    pidiendo la publicacion en bucle.
  */
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    if (enFeed || !id || !AuthRepository.enabled) {
      setEstado('listo');
      return;
    }
    let vivo = true;
    setEstado('cargando');
    PostRepository.getById(id, currentUserId)
      .then((p) => {
        if (!vivo) return;
        setPedida(p);
        setEstado('listo');
      })
      .catch((error) => {
        console.warn('[publicacion] no se pudo cargar', error);
        if (!vivo) return;
        // 404/403 es «ya no existe o no es tuya»; el resto es un fallo del que
        // se puede reintentar. Decir «eliminada» ante un corte de red miente.
        const status = (error as { status?: number })?.status;
        setEstado(status === 404 || status === 403 ? 'ausente' : 'error');
      });
    return () => {
      vivo = false;
    };
  }, [id, enFeed, currentUserId, intento]);

  const post = enFeed ?? pedida;

  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/home'));

  if (!post) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="Publicación" onBack={goBack} />
        {estado === 'cargando' ? (
          <StateView state="loading" />
        ) : estado === 'error' ? (
          <StateView
            state="error"
            icon="wifi-off"
            title="No pudimos cargar la publicación"
            description="Revisa tu conexión e inténtalo de nuevo."
            onRetry={() => setIntento((n) => n + 1)}
          />
        ) : (
          <StateView
            state="empty"
            icon="file-text"
            title="Publicación no disponible"
            description="Es posible que se haya eliminado o que ya no sea pública."
          />
        )}
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="Publicación" onBack={goBack} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.select({ ios: 'padding', android: 'height' })}
        keyboardVerticalOffset={keyboardOffset}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <PostCard post={post} onRemoved={goBack} />
          <ListRow
            title="Ver todos los comentarios"
            subtitle={`${post.commentsCount ?? post.comments.length} comentarios`}
            leftIcon="message-square"
            rightIcon="chevron-right"
            onPress={() => router.push(`/comments/${post.id}` as never)}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
});
