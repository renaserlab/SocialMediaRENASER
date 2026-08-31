import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { AppHeader } from '@/components/AppHeader';
import { Avatar } from '@/components/Avatar';
import { Input } from '@/components/Input';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import {
  anadirPagina,
  enviarComentario,
  estadoInicial,
  primeraPagina,
  type EstadoDeComentarios,
} from '@/lib/comentarios';
import { notify } from '@/lib/confirm';
import { PostRepository, type ComentarioConAvatar } from '@/repositories/PostRepository';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

/** Cuántos se piden de golpe. Ni tres ni mil: lo que cabe en dos pantallas. */
const POR_PAGINA = 20;

const comentariosDeMuestra: ComentarioConAvatar[] = [
  { id: '1', author: 'Sophia V.', text: 'Esto cambia completamente mi perspectiva.', createdAt: 'Hace 2 h' },
  { id: '2', author: 'Daniel M.', text: '¡Excelente lección! Totalmente recomendado.', createdAt: 'Hace 5 h' },
  { id: '3', author: 'Esteban R.', text: 'Aplicando esto desde hoy mismo.', createdAt: 'Hace 1 d' },
];

/**
 * Los comentarios de una publicación.
 *
 * TRES COSAS QUE ESTABAN MAL Y SE VEÍAN DESDE FUERA:
 *
 * 1. UN COMENTARIO RECHAZADO SE QUEDABA EN PANTALLA. Ante un 404 se conservaba
 *    el comentario optimista a propósito, con el argumento de que podía ser un
 *    short. Un 404 significa que la publicación no existe: el comentario no se
 *    guardó en ningún sitio y aun así se enseñaba como publicado. Ahora no hay
 *    ninguna excepción por código de error, y la decisión vive en
 *    `lib/comentarios`, donde se puede probar.
 *
 * 2. SE PEDÍA LA CUENTA DEMASIADO TARDE, O NO SE PEDÍA. El campo se vaciaba
 *    antes de saber si hay sesión, así que quien decidía no registrarse perdía
 *    lo escrito. Se usa `useRequireAuth`, el mismo flujo del muro y del feed de
 *    vídeo, y se pide ANTES de tocar nada.
 *
 * 3. LOS COMENTARIOS RECIENTES ERAN INALCANZABLES. El servidor ordenaba de
 *    antiguo a nuevo y recortaba con `limit`; la pantalla le daba la vuelta al
 *    lote DESPUÉS. Con 20 comentarios daba el pego; con 100, se veían los 20
 *    más viejos y lo recién escrito no aparecía nunca. Ahora el orden lo pone
 *    el servidor y se pagina con cursor hacia atrás.
 */
export function CommentsScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useAppTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const currentUser = useAppStore((state) => state.user);
  // Comentar queda a nombre de alguien: se pide cuenta al hacerlo, no al entrar.
  const requireAuth = useRequireAuth();

  // El contador que ya conoce el muro, para no arrancar de cero mientras carga.
  const contadorDelMuro = useAppStore(
    (state) => state.posts.find((post) => post.id === id)?.commentsCount,
  );
  const setPosts = useAppStore((state) => state.setPosts);

  const [estado, setEstado] = useState<EstadoDeComentarios<ComentarioConAvatar>>(() =>
    estadoInicial(),
  );
  const [status, setStatus] = useState<'loading' | 'idle' | 'error'>('loading');
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [cargandoMas, setCargandoMas] = useState(false);

  const load = useCallback(async () => {
    if (!supabaseEnabled) {
      setEstado(primeraPagina(comentariosDeMuestra, null));
      setStatus('idle');
      return;
    }
    setStatus('loading');
    try {
      const pagina = await PostRepository.listCommentsPage(id, { limit: POR_PAGINA });
      setEstado(primeraPagina(pagina.items, pagina.siguiente, contadorDelMuro));
      setStatus('idle');
    } catch {
      setStatus('error');
    }
    // `contadorDelMuro` a propósito fuera: cambia al publicar y volver a cargar
    // la lista entera por eso sería tirar el scroll de quien está leyendo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, supabaseEnabled]);

  useEffect(() => {
    void load();
  }, [load]);

  /** La página siguiente, hacia atrás en el tiempo. */
  const cargarMas = useCallback(async () => {
    if (!supabaseEnabled || cargandoMas || !estado.cursor) return;
    setCargandoMas(true);
    try {
      const pagina = await PostRepository.listCommentsPage(id, {
        limit: POR_PAGINA,
        before: estado.cursor,
      });
      // `anadirPagina` descarta por id lo que ya está: si alguien comenta
      // mientras se lee, el lote siguiente puede solaparse con el anterior.
      setEstado((previo) => anadirPagina(previo, pagina.items, pagina.siguiente));
    } catch {
      // Sin ruido: lo cargado sigue en pantalla y se puede reintentar bajando.
    } finally {
      setCargandoMas(false);
    }
  }, [cargandoMas, estado.cursor, id, supabaseEnabled]);

  /**
   * Deja el contador del muro cuadrado con lo que acaba de pasar.
   *
   * Sin esto, publicar desde aquí y volver atrás enseñaba el número de antes:
   * la tarjeta pinta `commentsCount`, que viene del feed y no se entera de lo
   * que ocurre en esta pantalla.
   */
  const sumarAlContadorDelMuro = useCallback(
    (delta: number) => {
      if (delta === 0) return;
      const { posts } = useAppStore.getState();
      if (!posts.some((post) => post.id === id)) return;
      setPosts(
        posts.map((post) =>
          post.id === id
            ? {
                ...post,
                commentsCount: (post.commentsCount ?? post.comments.length) + delta,
              }
            : post,
        ),
      );
    },
    [id, setPosts],
  );

  const sendComment = async () => {
    setSending(true);
    try {
      const resultado = await enviarComentario<ComentarioConAvatar>({
        estado,
        texto: inputText,
        // Se resuelve ANTES de vaciar el campo: si dice que no, el texto sigue
        // ahí y no se ha pintado ningún comentario que nadie llegó a publicar.
        autorizar: async () => {
          let autorizado = false;
          await requireAuth('auth.reasonComment', () => {
            autorizado = true;
          });
          return autorizado;
        },
        crear: async (texto) => {
          if (!supabaseEnabled) {
            // Modo demostración, sin backend: no hay a quién preguntar. El
            // comentario es local y se dice con un id local, no con uno falso.
            return {
              id: `local-${Date.now()}`,
              author: currentUser?.fullName ?? t('common.you'),
              text: texto,
              createdAt: t('time.now'),
            };
          }
          return PostRepository.addComment(id, texto);
        },
        optimista: (texto, idProvisional) => ({
          id: idProvisional,
          author: currentUser?.fullName ?? t('common.you'),
          text: texto,
          createdAt: t('time.now'),
        }),
      });

      setEstado(resultado.estado);
      setInputText(resultado.texto);
      sumarAlContadorDelMuro(resultado.delta);
      if (resultado.fallo === 'servidor') {
        notify(t('post.commentFailed'), t('common.checkConnection'));
      }
    } finally {
      setSending(false);
    }
  };

  const uiState =
    status === 'loading'
      ? 'loading'
      : status === 'error'
        ? 'error'
        : estado.lista.length === 0
          ? 'empty'
          : 'content';

  return (
    <SinTecladoDelante style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title={
          estado.total > 0
            ? t('post.commentsWithCount', { count: estado.total })
            : t('post.comments')
        }
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />
      <View style={styles.container}>
        <StateView
          state={uiState}
          onRetry={load}
          title={uiState === 'empty' ? t('post.beFirstToComment') : undefined}
          description={uiState === 'empty' ? t('post.noCommentsYet') : undefined}
        >
          <FlatList
            data={estado.lista}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.listContent}
            onEndReached={() => void cargarMas()}
            onEndReachedThreshold={0.4}
            ListFooterComponent={
              cargandoMas ? <ActivityIndicator style={styles.masAbajo} color={colors.textMuted} /> : null
            }
            renderItem={({ item }) => (
              <View style={[styles.commentRow, { borderBottomColor: colors.border }]}>
                {/* La foto real de quien comenta; sin ella, la silueta de siempre. */}
                <Avatar size={36} image={item.avatarUrl ?? 'avatar'} name={item.author} />
                <View style={styles.textContainer}>
                  <View style={styles.commentHeader}>
                    <Text style={[styles.author, { color: colors.text }]}>{item.author}</Text>
                    <Text style={[styles.time, { color: colors.textMuted }]}>{item.createdAt}</Text>
                  </View>
                  <Text style={[styles.commentText, { color: colors.text }]}>{item.text}</Text>
                </View>
              </View>
            )}
          />
        </StateView>
        <View
          style={[
            styles.inputBar,
            {
              borderTopColor: colors.border,
              backgroundColor: colors.background,
              // Evita que el campo quede bajo la barra de gestos / home indicator.
              paddingBottom: spacing.md + insets.bottom,
            },
          ]}
        >
          <Input
            placeholder={t('post.writeComment')}
            value={inputText}
            onChangeText={setInputText}
            containerStyle={styles.inputContainer}
          />
          <Button
            label={t('common.send')}
            variant="ghost"
            onPress={sendComment}
            loading={sending}
            disabled={!inputText.trim()}
          />
        </View>
      </View>
    </SinTecladoDelante>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'space-between',
  },
  listContent: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  masAbajo: {
    paddingVertical: spacing.md,
  },
  commentRow: {
    flexDirection: 'row',
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    gap: spacing.md,
  },
  textContainer: {
    flex: 1,
  },
  commentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  author: {
    fontSize: 13,
    fontWeight: '700',
  },
  time: {
    fontSize: 10,
  },
  commentText: {
    fontSize: 13,
    lineHeight: 18,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderTopWidth: 1,
    gap: spacing.sm,
  },
  inputContainer: {
    flex: 1,
  },
});
