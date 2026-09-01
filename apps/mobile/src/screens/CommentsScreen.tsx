import React, { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { AppHeader } from '@/components/AppHeader';
import { ContenidoDeComentarios } from '@/components/ContenidoDeComentarios';
import { useComentarios } from '@/hooks/useComentarios';
import { irAlPerfil } from '@/lib/irAlPerfil';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * Los comentarios de una publicación, a pantalla completa.
 *
 * SIGUE EXISTIENDO aunque desde el muro se abra una hoja: es el destino de
 * `/comments/{id}`, que es a donde llevan los avisos y los enlaces compartidos.
 * Lo que cambió es que la carga, la paginación, el composer y los estados ya no
 * viven aquí sino en `useComentarios` + `ContenidoDeComentarios`, que es lo
 * mismo que monta la hoja. Una sola implementación, dos marcos.
 */
export function CommentsScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useAppTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const comentarios = useComentarios(id);

  // Aquí no hay hoja que cerrar: se navega directo.
  const alTocarPersona = useCallback(
    (persona: { id: string }) => irAlPerfil(router, persona.id),
    [router],
  );

  return (
    <SinTecladoDelante style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title={
          comentarios.estado.total > 0
            ? t('post.commentsWithCount', { count: comentarios.estado.total })
            : t('post.comments')
        }
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />
      <View style={styles.container}>
        <ContenidoDeComentarios
          comentarios={comentarios}
          onPersonPress={alTocarPersona}
          // Evita que el campo quede bajo la barra de gestos.
          paddingInferior={insets.bottom}
        />
      </View>
    </SinTecladoDelante>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
