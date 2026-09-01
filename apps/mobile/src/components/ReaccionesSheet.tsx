import React, { useCallback } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { useRouter } from 'expo-router';

import { BottomSheet } from '@/components/BottomSheet';
import { ListaDeReacciones } from '@/components/ListaDeReacciones';
import { Text } from '@/components/Text';
import { irAlPerfil } from '@/lib/irAlPerfil';
import { spacing } from '@/theme/tokens';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * Quién reaccionó, SIN salir de la publicación.
 *
 * EL FALLO QUE ARREGLA. Pulsar el número abría `/reacciones/{id}`, una pantalla
 * completa: la barra de navegación desaparecía —no es una sección, así que
 * `SwipeTabs` la pinta encima— y se perdía de vista la publicación que se
 * estaba mirando. Para una lista de nombres, cambiar de pantalla entera es
 * demasiado: se pierde el sitio y volver cuesta un gesto.
 *
 * Sube desde abajo y deja la publicación detrás, que es lo que se pidió y lo
 * que hacen las demás aplicaciones. No es una hoja nueva: es el `BottomSheet`
 * que ya usan las reseñas, los eventos y los cursos.
 *
 * ALTURA FIJA, y no «lo que mida el contenido». Dentro va un `FlashList`, que
 * necesita saber cuánto mide para decidir qué filas existen. Con altura
 * automática mediría cero y no pintaría nada. El 62 % deja ver la publicación
 * por encima —que es el punto de no perder el contexto— y da sitio a unas seis
 * filas, suficientes para que se entienda que la lista sigue.
 */
const PARTE_DE_LA_PANTALLA = 0.62;

export function ReaccionesSheet({
  postId,
  visible,
  onClose,
}: {
  postId: string | null;
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { height } = useWindowDimensions();
  const router = useRouter();

  /*
    Cerrar ANTES de navegar. La lista navegaba sola y el Modal se quedaba
    montado sobre el perfil al que acababa de llevar: no se iba al tocar fuera
    ni habia forma de quitarlo.

    Sin espera: `onClose` deja `visible` en falso en el mismo lote de React, y
    navegar por debajo de un Modal que se cierra no tiene el problema de
    presentar algo encima (que es para lo que existe `afterSheetClose`).
  */
  const alTocarPersona = useCallback(
    (persona: { id: string }) => {
      onClose();
      irAlPerfil(router, persona.id);
    },
    [onClose, router],
  );

  return (
    /*
      `desplazable={false}`: el desplazamiento lo lleva el `FlashList` de
      dentro. Con el `ScrollView` de la hoja, la lista virtualizada perdería la
      altura con la que recicla filas.

      El cierre —arrastrar, tocar fuera, atrás de Android— ya lo resuelve el
      `BottomSheet` con su `Modal` y su `onRequestClose`. No hace falta nada
      aquí.
    */
    <BottomSheet visible={visible} onClose={onClose} desplazable={false}>
      <View style={[styles.contenedor, { height: height * PARTE_DE_LA_PANTALLA }]}>
        <Text variant="body" weight="700" style={styles.titulo}>
          {t('post.reactions')}
        </Text>
        {/*
          Solo se pide la lista con la hoja abierta. Cada tarjeta del muro monta
          este componente, y sin esta guarda abrir el feed dispararía una
          petición de reacciones por publicación visible.
        */}
        {visible ? <ListaDeReacciones postId={postId} onPersonPress={alTocarPersona} /> : null}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  contenedor: { flexShrink: 1 },
  titulo: { textAlign: 'center', marginBottom: spacing.md },
});
