import React, { useCallback } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { useRouter } from 'expo-router';

import { BottomSheet } from '@/components/BottomSheet';
import { ContenidoDeComentarios } from '@/components/ContenidoDeComentarios';
import { Text } from '@/components/Text';
import { useComentarios } from '@/hooks/useComentarios';
import { irAlPerfil } from '@/lib/irAlPerfil';
import { spacing } from '@/theme/tokens';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * Altura fija, no «lo que mida el contenido»: dentro va un `FlatList`, que sin
 * altura conocida mide cero. Más alta que la de reacciones porque aquí se
 * escribe, y el campo tiene que quedar cómodo; aun así deja ver la publicación.
 */
const PARTE_DE_LA_PANTALLA = 0.75;

/**
 * El cuerpo va aparte para que `useComentarios` SOLO exista con la hoja
 * abierta. Cada tarjeta del muro monta esta hoja; con el hook fuera, abrir el
 * feed pediría los comentarios de todas las publicaciones visibles.
 */
function Cuerpo({
  postId,
  totalConocido,
  onClose,
}: {
  postId: string;
  totalConocido?: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const comentarios = useComentarios(postId, totalConocido);

  /*
    Cerrar ANTES de navegar, igual que en la hoja de reacciones: si no, el Modal
    se queda montado sobre el perfil al que lleva. Sin espera: `onClose` deja
    `visible` en falso en el mismo lote de React.
  */
  const alTocarPersona = useCallback(
    (persona: { id: string }) => {
      onClose();
      irAlPerfil(router, persona.id);
    },
    [onClose, router],
  );

  return (
    <>
      <Text variant="body" weight="700" style={styles.titulo}>
        {comentarios.estado.total > 0
          ? t('post.commentsWithCount', { count: comentarios.estado.total })
          : t('post.comments')}
      </Text>
      {/* La hoja ya va dentro de `SinTecladoDelante`; aquí no hace falta hueco. */}
      <ContenidoDeComentarios comentarios={comentarios} onPersonPress={alTocarPersona} />
    </>
  );
}

export function CommentsSheet({
  postId,
  totalConocido,
  visible,
  onClose,
}: {
  postId: string | null;
  /**
   * Cuántos comentarios dice quien la abre que hay. Solo lo pasa el feed de
   * vídeo de Inicio, cuya publicación puede no estar en el muro (ver
   * `useComentarios`).
   */
  totalConocido?: number;
  visible: boolean;
  onClose: () => void;
}) {
  const { height } = useWindowDimensions();

  return (
    /*
      `desplazable={false}`: el desplazamiento lo lleva el `FlatList` de dentro.
      Cerrar —arrastrar, tocar fuera, atrás de Android— ya lo resuelve el
      `BottomSheet` con su `Modal` y su `onRequestClose`.
    */
    <BottomSheet visible={visible} onClose={onClose} desplazable={false}>
      <View style={[styles.contenedor, { height: height * PARTE_DE_LA_PANTALLA }]}>
        {visible && postId ? <Cuerpo postId={postId} totalConocido={totalConocido} onClose={onClose} /> : null}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  contenedor: { flexShrink: 1 },
  titulo: { textAlign: 'center', marginBottom: spacing.md },
});
