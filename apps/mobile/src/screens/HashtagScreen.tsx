import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useLocalSearchParams } from 'expo-router';

import { AppScreen } from '@/components/AppScreen';
import { AppHeader } from '@/components/AppHeader';
import { PostCard } from '@/components/PostCard';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { AuthRepository } from '@/repositories/AuthRepository';
import { HashtagRepository, type HashtagDto } from '@/repositories/HashtagRepository';
import { useAppStore } from '@/store/useAppStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Post } from '@/types';
import { useTranslation } from '@/i18n/useTranslation';

const POR_PAGINA = 20;

/**
 * Todo lo publicado con una etiqueta.
 *
 * QUE SE ENSEÑA Y POR QUE ESE NUMERO ES EL REAL. La cabecera dice «#python» y
 * «N publicaciones», y esa N la calcula el servidor contando SOLO lo publicado:
 * si contara borradores y contenido retirado, diría 12 y la lista de debajo
 * enseñaría 8. Un número que no cuadra con lo que se ve es peor que no poner
 * número, así que se pide aparte en vez de deducirlo de la primera página —que
 * como mucho sabría decir «20».
 *
 * UNA ETIQUETA QUE NADIE USO NO ES UN ERROR. Responde cero publicaciones y la
 * pantalla lo dice con normalidad. Lo mismo pasa mientras la migración 0031
 * espere aprobación: el backend contesta vacío, no falla, y aquí no hay nada
 * que distinguir.
 */
export function HashtagScreen() {
  const { t } = useTranslation();
  const { name } = useLocalSearchParams<{ name: string }>();
  const { colors } = useAppTheme();
  const currentUserId = useAppStore((state) => state.user?.id ?? null);

  const [detalle, setDetalle] = useState<HashtagDto | null>(null);
  const [publicaciones, setPublicaciones] = useState<Post[]>([]);
  const [estado, setEstado] = useState<'cargando' | 'error' | 'listo'>('cargando');
  const [hayMas, setHayMas] = useState(true);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [refrescando, setRefrescando] = useState(false);
  /*
    Reintento explicito. El estado NO puede ir en las dependencias del efecto:
    el propio efecto lo cambia, asi que se volveria a disparar solo y quedaria
    pidiendo la etiqueta en bucle. Mismo patron que PostDetailScreen.
  */
  const [intento, setIntento] = useState(0);

  const etiqueta = typeof name === 'string' ? name : '';

  useEffect(() => {
    if (!etiqueta || !AuthRepository.enabled) {
      setEstado('listo');
      return;
    }
    let vivo = true;
    setEstado('cargando');

    /*
      Las dos peticiones van EN PARALELO y no una detras de otra: la cabecera y
      la lista no dependen entre si, y encadenarlas doblaria la espera antes de
      pintar nada.
    */
    Promise.all([
      HashtagRepository.detalle(etiqueta),
      HashtagRepository.publicaciones(
        etiqueta,
        { limit: POR_PAGINA, offset: 0 },
        currentUserId,
      ),
    ])
      .then(([cabecera, lista]) => {
        if (!vivo) return;
        setDetalle(cabecera);
        setPublicaciones(lista);
        setHayMas(lista.length === POR_PAGINA);
        setEstado('listo');
      })
      .catch((error) => {
        if (!vivo) return;
        console.warn('[hashtag] no se pudo cargar la etiqueta', error);
        setEstado('error');
      });

    return () => {
      vivo = false;
    };
  }, [etiqueta, currentUserId, intento]);

  const cargarMas = useCallback(async () => {
    // Sin esta guarda, el scroll infinito lanza una peticion por fotograma
    // mientras dura la anterior y la lista acaba con publicaciones repetidas.
    if (cargandoMas || !hayMas || estado !== 'listo') return;
    setCargandoMas(true);
    try {
      const siguiente = await HashtagRepository.publicaciones(
        etiqueta,
        { limit: POR_PAGINA, offset: publicaciones.length },
        currentUserId,
      );
      setPublicaciones((previas) => {
        // Se descarta lo que ya estuviera: si entra una publicacion nueva entre
        // dos paginas, el desplazamiento se corre y la ultima de la anterior
        // vuelve a llegar. Repetida en pantalla se ve, y ademas React avisa por
        // la clave duplicada.
        const vistas = new Set(previas.map((p) => p.id));
        return [...previas, ...siguiente.filter((p) => !vistas.has(p.id))];
      });
      setHayMas(siguiente.length === POR_PAGINA);
    } catch (error) {
      console.warn('[hashtag] no se pudo cargar mas', error);
      // No se marca la pantalla como rota: lo que ya se ve sigue siendo valido.
      setHayMas(false);
    } finally {
      setCargandoMas(false);
    }
  }, [cargandoMas, hayMas, estado, etiqueta, publicaciones.length, currentUserId]);

  const refrescar = useCallback(async () => {
    setRefrescando(true);
    setIntento((n) => n + 1);
    setRefrescando(false);
  }, []);

  // Lo que se pinta arriba: la etiqueta y su cuenta real.
  const titulo = detalle?.display_tag ?? etiqueta.replace(/^#/, '');
  const cuantas = detalle?.posts_count ?? 0;

  return (
    <AppScreen scroll={false}>
      <AppHeader title={`#${titulo}`} back />
      <StateView
        state={
          estado === 'cargando'
            ? 'loading'
            : estado === 'error'
            ? 'error'
            : publicaciones.length === 0
            ? 'empty'
            : 'content'
        }
        icon="hash"
        title={estado === 'error' ? t('hashtag.loadFailed') : t('hashtag.empty')}
        description={
          estado === 'error'
            ? t('common.tryAgainSoon')
            : t('hashtag.emptyBody', { etiqueta: titulo })
        }
        onRetry={() => setIntento((n) => n + 1)}
      >
        <FlashList
          data={publicaciones}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.lista}
          ListHeaderComponent={
            <View style={styles.cabecera}>
              <Text variant="title" accessibilityRole="header">
                #{titulo}
              </Text>
              <Text variant="secondary" color={colors.textMuted}>
                {/* El plural se escribe entero: «1 publicaciones» se lee mal. */}
                {cuantas === 1
                  ? t('search.postsCountOne')
                  : t('search.postsCountMany', { count: cuantas })}
              </Text>
            </View>
          }
          // Con margen lateral, como en el muro o en Guardados: sin el, las
          // tarjetas iban de borde a borde. Va en cada tarjeta y no en la lista
          // porque la cabecera ya trae el suyo.
          renderItem={({ item }) => (
            <View style={styles.tarjeta}>
              <PostCard post={item} />
            </View>
          )}
          onEndReached={cargarMas}
          onEndReachedThreshold={0.6}
          refreshControl={
            <RefreshControl refreshing={refrescando} onRefresh={refrescar} tintColor={colors.text} />
          }
        />
      </StateView>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  lista: { paddingBottom: 120 },
  tarjeta: { paddingHorizontal: spacing.lg },
  cabecera: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
    gap: 2,
  },
});
