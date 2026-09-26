import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppScreen } from '@/components/AppScreen';
import { AppHeader } from '@/components/AppHeader';
import { PostCard } from '@/components/PostCard';
import { StateView } from '@/components/StateView';
import { estadoDeGuardados } from '@/lib/guardados';
import { AuthRepository } from '@/repositories/AuthRepository';
import { PostRepository } from '@/repositories/PostRepository';
import { useAppStore } from '@/store/useAppStore';
import { spacing } from '@/theme/tokens';
import type { Post } from '@/types';
import { useTranslation } from '@/i18n/useTranslation';

/** Lo que cabe en un par de pantallas. No se traen mil de golpe. */
const POR_PAGINA = 20;

/**
 * Lo que esta persona ha guardado, desde el SERVIDOR.
 *
 * POR QUE CAMBIA. La pantalla cruzaba `savedPostIds` —una lista guardada en el
 * teléfono— con las publicaciones que hubiera en memoria. Tres consecuencias,
 * las mismas que ya se corrigieron en la biblioteca con los cursos:
 *
 *   - se vaciaba al reinstalar,
 *   - no se compartía entre dispositivos,
 *   - y sólo podía enseñar lo que estuviera en el muro cargado, así que
 *     guardar algo y bajar un rato lo hacía desaparecer de aquí.
 *
 * Guardar es un hecho del servidor, no una preferencia local.
 *
 * QUITAR EL MARCADOR NO BORRA LA FILA AL MOMENTO, a propósito: la tarjeta ya
 * enseña el marcador apagado y quien se equivocó puede volver a pulsarlo sin
 * buscar la publicación otra vez. Desaparece al volver a entrar.
 */
export function SavedScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const currentUserId = useAppStore((state) => state.user?.id);

  const [guardadas, setGuardadas] = useState<Post[] | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);
  const [hayMas, setHayMas] = useState(true);
  const [cargandoMas, setCargandoMas] = useState(false);

  const cargar = useCallback(async () => {
    if (!AuthRepository.enabled) {
      setGuardadas([]);
      setHayMas(false);
      return;
    }
    try {
      const pagina = await PostRepository.listSaved({ limit: POR_PAGINA }, currentUserId);
      setGuardadas(pagina);
      setHayMas(pagina.length === POR_PAGINA);
      setFallo(null);
    } catch (error) {
      // Un fallo de red no puede convertirse en «no tienes nada guardado».
      setFallo(error instanceof Error ? error.message : t('saved.loadFailedBody'));
      setGuardadas([]);
      setHayMas(false);
    }
  }, [currentUserId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  // El primer foco se salta: al montar ya carga el efecto de arriba. Es el
  // mismo motivo que en la biblioteca, donde se pedía la lista dos veces.
  const yaSeEnfoco = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!yaSeEnfoco.current) {
        yaSeEnfoco.current = true;
        return;
      }
      void cargar();
    }, [cargar]),
  );

  const cargarMas = useCallback(async () => {
    if (!AuthRepository.enabled || cargandoMas || !hayMas || !guardadas) return;
    setCargandoMas(true);
    try {
      const pagina = await PostRepository.listSaved(
        { limit: POR_PAGINA, offset: guardadas.length },
        currentUserId,
      );
      setHayMas(pagina.length === POR_PAGINA);
      // Por id: dos páginas pueden solaparse si se guarda algo mientras se lee.
      setGuardadas((previas) => {
        const conocidas = new Set((previas ?? []).map((post) => post.id));
        return [...(previas ?? []), ...pagina.filter((post) => !conocidas.has(post.id))];
      });
    } catch {
      // Lo cargado sigue en pantalla; se puede reintentar bajando otra vez.
    } finally {
      setCargandoMas(false);
    }
  }, [cargandoMas, currentUserId, guardadas, hayMas]);

  // La misma regla que usa «Mis Audios»: se decide en un sitio y se prueba una
  // vez, porque distinguir «no hay nada» de «no se pudo cargar» es justo lo que
  // se estaba haciendo mal.
  const estado = estadoDeGuardados(guardadas, fallo);

  return (
    <AppScreen scroll={false}>
      <AppHeader
        title={t('profile.saved')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/profile'))}
      />
      <StateView
        state={estado}
        icon="bookmark"
        onRetry={cargar}
        title={estado === 'error' ? t('saved.loadFailed') : t('saved.empty')}
        description={estado === 'error' ? (fallo ?? undefined) : t('saved.emptyBody')}
      >
        <FlashList
          data={guardadas ?? []}
          keyExtractor={(item: Post) => item.id}
          contentContainerStyle={styles.content}
          renderItem={({ item }: { item: Post }) => <PostCard post={item} />}
          onEndReached={() => void cargarMas()}
          onEndReachedThreshold={0.4}
          showsVerticalScrollIndicator={false}
        />
      </StateView>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },
});
