import React, { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, RefreshControl, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';

import { PostCard } from '@/components/PostCard';
import { Skeleton } from '@/components/Skeleton';
import { StateView } from '@/components/StateView';
import { useKeyboardOffset } from '@/hooks/useKeyboardOffset';
import { useTranslation } from '@/i18n/useTranslation';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Post } from '@/types';

/**
 * El muro de publicaciones: fotos, textos y videos de la comunidad.
 *
 * POR QUE ES UN COMPONENTE Y NO UNA PANTALLA. Esto vivia dentro de `Inicio`.
 * Al convertirse Inicio en el feed vertical de video, el muro se muda a
 * Explorar; y para que "mudarse" no acabe siendo "copiarse", todo lo que sabe
 * hacer —la ventana de reproductores, la visibilidad, la paginacion, el gesto
 * de refrescar, los estados de carga y de fallo— se queda en un unico sitio.
 * Quien lo use solo aporta lo que va ENCIMA y lo que va DEBAJO de la lista.
 *
 * Sigue siendo una lista virtualizada de verdad: la cabecera y el pie viajan
 * dentro de la propia FlashList (`ListHeaderComponent` / `ListFooterComponent`)
 * en lugar de envolverla en un ScrollView, que es lo que mataria el reciclado
 * y montaria todas las publicaciones a la vez.
 */

/**
 * Cuantos videos del muro pueden sonar a la vez.
 *
 * Si en la pantalla caben dos publicaciones con video, las dos se reproducen:
 * es lo que se ve en cualquier red social y lo que pedia el documento (antes
 * mandaba uno solo y el segundo se quedaba congelado con un boton de play).
 * El tope existe para que "los que se ven" no se convierta en "todos los que
 * la lista tenga montados": tres es mas de lo que cabe de verdad en un movil.
 */
const MAX_VIDEOS_REPRODUCIENDO = 3;

/**
 * Cuantos videos se preparan por delante sin reproducirse.
 *
 * Es lo que hace que al llegar a ellos ya tengan bytes descargados y empiecen
 * al instante en vez de en negro.
 */
const MAX_VIDEOS_PREPARANDO = 2;

/**
 * Techo duro de reproductores vivos en todo el muro.
 *
 * Cada reproductor reserva memoria nativa (ver MAX_BUFFER_BYTES en
 * VideoPlayer), y quedarse sin ella es lo que cerraba la aplicacion de golpe
 * en Android. Reproduciendo + preparando nunca pasan de aqui.
 */
const MAX_REPRODUCTORES = 4;

/** Dos listas de ids con el mismo contenido y el mismo orden. */
function mismasListas(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

type Props = {
  /** Lo que se pinta por encima de la primera publicacion. */
  cabecera?: React.ReactElement | null;
  /** Lo que se pinta despues de la ultima. */
  pie?: React.ReactElement | null;
  /**
   * Trabajo extra al deslizar hacia abajo (recargar el catalogo de Explorar,
   * por ejemplo). El muro siempre recarga lo suyo; esto se suma.
   */
  alRefrescar?: () => Promise<void> | void;
  /** Espacio libre al final, para que la barra flotante no tape nada. */
  espacioInferior?: number;
};

export function MuroDePublicaciones({
  cabecera,
  pie,
  alRefrescar,
  espacioInferior = 120,
}: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const keyboardOffset = useKeyboardOffset();

  const posts = useAppStore((state) => state.posts);
  const feedStatus = useAppStore((state) => state.feedStatus);
  const feedHasMore = useAppStore((state) => state.feedHasMore);
  const feedLoadingMore = useAppStore((state) => state.feedLoadingMore);
  const feedError = useAppStore((state) => state.feedError);
  const loadFeed = useAppStore((state) => state.loadFeed);
  const loadMoreFeed = useAppStore((state) => state.loadMoreFeed);

  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    // `loadFeed` deduplica por dentro: si otra carga igual esta en vuelo (por
    // ejemplo, el doble montaje de StrictMode), esta llamada espera a esa.
    void loadFeed();
  }, [loadFeed]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([loadFeed(), alRefrescar?.()]);
    } finally {
      setRefreshing(false);
    }
  }, [loadFeed, alRefrescar]);

  const onEndReached = useCallback(() => {
    if (feedHasMore && !feedLoadingMore) void loadMoreFeed();
  }, [feedHasMore, feedLoadingMore, loadMoreFeed]);

  /*
    Publicaciones a la vista y videos que suenan.

    Los videos del muro se reproducen SOLOS al aparecer, como en Instagram, y
    en silencio (quien quiera sonido lo activa en el propio video).

    La regla, en una linea: se ve → puede reproducirse; no se ve → se pausa y
    se suelta. Todo lo que este de verdad en pantalla suena, hasta
    MAX_VIDEOS_REPRODUCIENDO; nada de lo que no este en pantalla suena nunca.

    Ademas se preparan los siguientes videos del muro aunque todavia no se
    vean: al llegar a ellos ya tienen bytes descargados y empiezan al instante
    en vez de en negro. Preparar NO es reproducir; esos reproductores existen
    callados y parados.

    Se guardan ids y no indices porque la lista se reordena al recargar; con
    indices, el video que se pausa despues de un refresco no seria el mismo.

    El umbral es del 35 %: no hace falta que la publicacion ocupe casi toda la
    pantalla para que su video arranque, basta con que una parte util haya
    entrado. `minimumViewTime` evita el otro extremo —arrancar veinte videos de
    golpe al pasar el dedo rapido—: la publicacion tiene que seguir ahi cien
    milisegundos, un tiempo que nadie percibe pero que un desplazamiento rapido
    no le concede a nada.
  */
  const [visibleIds, setVisibleIds] = useState<Set<string>>(() => new Set());
  const [videosEnCurso, setVideosEnCurso] = useState<{
    reproduciendo: string[];
    preparando: string[];
  }>({ reproduciendo: [], preparando: [] });

  /*
    La lista actual, accesible desde el manejador de visibilidad sin volver a
    crearlo. El manejador vive en un `useRef` porque FlashList no admite que
    cambie entre renders, asi que no puede cerrar sobre `posts` directamente:
    se quedaria mirando siempre la primera lista.
  */
  const postsRef = useRef(posts);
  postsRef.current = posts;

  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 35,
    minimumViewTime: 100,
  }).current;

  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: Array<{ key?: string; item?: Post }> }) => {
      const idsVisibles = viewableItems
        .map((entry) => entry.item?.id ?? entry.key)
        .filter((id): id is string => typeof id === 'string');
      setVisibleIds(new Set(idsVisibles));

      // Todos los videos que estan de verdad en pantalla, en el orden en que se
      // leen las publicaciones (arriba primero), con tope de seguridad.
      const reproduciendo = viewableItems
        .filter((entry) => entry.item?.mediaType === 'video')
        .map((entry) => entry.item!.id)
        .slice(0, MAX_VIDEOS_REPRODUCIENDO);

      /*
        Y los siguientes videos del muro, para tenerlos preparados al llegar.
        Se cuentan desde el ultimo video que suena; si no suena ninguno (solo
        hay fotos en pantalla), desde la ultima publicacion visible, que es
        hacia donde va el dedo.
      */
      const lista = postsRef.current;
      const referencia = reproduciendo.length
        ? reproduciendo[reproduciendo.length - 1]
        : idsVisibles[idsVisibles.length - 1];
      const desde = referencia ? lista.findIndex((post) => post.id === referencia) : -1;
      const cupo = Math.min(MAX_REPRODUCTORES - reproduciendo.length, MAX_VIDEOS_PREPARANDO);
      const preparando =
        desde >= 0 && cupo > 0
          ? lista
              .slice(desde + 1)
              .filter((post) => post.mediaType === 'video')
              .slice(0, cupo)
              .map((post) => post.id)
          : [];

      setVideosEnCurso((previo) =>
        mismasListas(previo.reproduciendo, reproduciendo) &&
        mismasListas(previo.preparando, preparando)
          ? previo
          : { reproduciendo, preparando },
      );
    },
  ).current;

  const cargandoPrimeraVez = feedStatus === 'loading' && posts.length === 0;

  const vacio = cargandoPrimeraVez ? (
    <View style={styles.container}>
      <View style={styles.skeletonContainer}>
        {[1, 2].map((i) => (
          <View key={i} style={[styles.skeletonCard, { borderColor: colors.border }]}>
            <View style={styles.skeletonHeader}>
              <Skeleton width={40} height={40} circle />
              <View style={{ gap: 6, flex: 1 }}>
                <Skeleton width="40%" height={12} />
                <Skeleton width="20%" height={10} />
              </View>
            </View>
            <Skeleton width="90%" height={14} />
            <Skeleton width="70%" height={14} />
          </View>
        ))}
      </View>
    </View>
  ) : feedStatus === 'error' ? (
    // Se pasa el motivo real: si el telefono esta sin cobertura, decirlo evita
    // que se lea como un fallo de la aplicacion y reintentos que no van a
    // funcionar hasta recuperar la conexion.
    <StateView state="error" description={feedError ?? undefined} onRetry={() => void loadFeed()} />
  ) : (
    <StateView state="empty" title={t('home.emptyTitle')} description={t('home.emptyBody')} />
  );

  return (
    // El comentario inline de PostCard vive dentro de esta lista: el KAV debe
    // estar a nivel de pantalla, nunca dentro del item.
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.select({ ios: 'padding', android: 'height' })}
      keyboardVerticalOffset={keyboardOffset}
    >
      <FlashList
        data={posts}
        keyExtractor={(item: Post) => item.id}
        renderItem={({ item }: { item: Post }) => (
          <View style={styles.container}>
            <PostCard
              post={item}
              visible={visibleIds.has(item.id)}
              videoActive={videosEnCurso.reproduciendo.includes(item.id)}
              videoPreload={videosEnCurso.preparando.includes(item.id)}
            />
          </View>
        )}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        ListHeaderComponent={cabecera ?? undefined}
        ListEmptyComponent={vacio}
        ListFooterComponent={
          <View>
            {feedLoadingMore ? (
              <View style={styles.footer}>
                <Skeleton width="90%" height={14} />
              </View>
            ) : null}
            {pie}
            {/* Hueco para que lo ultimo no quede bajo la barra flotante. */}
            <View style={{ height: espacioInferior }} />
          </View>
        }
        onEndReached={onEndReached}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.text}
            colors={[colors.text]}
          />
        }
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing.lg },
  footer: { paddingHorizontal: spacing.lg, paddingVertical: spacing.lg },
  skeletonContainer: { gap: spacing.md },
  skeletonCard: { padding: spacing.lg, borderWidth: 1, borderRadius: radius.md, gap: spacing.md },
  skeletonHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
