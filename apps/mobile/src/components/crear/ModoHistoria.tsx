import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Feather } from '@expo/vector-icons';

import { Button } from '@/components/Button';
import { ProgresoDePublicacion } from '@/components/crear/ProgresoDePublicacion';
import { PasoDeCaptura } from '@/components/crear/PasoDeCaptura';
import { Text } from '@/components/Text';
import { VideoPlayer } from '@/components/VideoPlayer';
import { usePublicacion, PublicacionCancelada } from '@/hooks/usePublicacion';
import { toast } from '@/lib/toast';
import { uploadPostMedia, type PickedMedia } from '@/services/storage';
import { useAppStore } from '@/store/useAppStore';
import { palette, spacing } from '@/theme/tokens';

const media = palette('dark');

/** Tope de una historia; coincide con el CHECK de la migracion 0003. */
export const MAX_HISTORIA_MS = 15_000;
/** Lo que dura una foto en el visor. */
const FOTO_MS = 5_000;

type Props = {
  /** Selector de modo, que viaja hasta dentro de la camara. */
  pie?: React.ReactNode;
  /** A donde ir al terminar o al cerrar. */
  alSalir: () => void;
  /** `false` mientras la pantalla no se esta viendo (ver `PasoDeCaptura`). */
  activo?: boolean;
};

/**
 * Crear una historia: camara o carrete → revision → publicar.
 *
 * Es el UNICO flujo de historia que hay. La ruta `/stories/nueva` ya no es una
 * pantalla: redirige aqui. Con dos copias, cada arreglo del limite de duracion,
 * de los permisos o del reintento habria que hacerlo dos veces y una de las dos
 * se quedaria atras.
 */
export function ModoHistoria({ pie, alSalir, activo = true }: Props) {
  const createStory = useAppStore((state) => state.createStory);
  const [elegido, setElegido] = useState<PickedMedia | null>(null);
  const envio = usePublicacion();

  const publicar = useCallback(() => {
    if (!elegido) return;
    const duracion = elegido.durationMs ?? 0;

    void envio.ejecutar(async ({ avance, cancelado }) => {
      /*
        El limite se comprueba ANTES de subir nada. Comprobarlo despues
        significaria gastar la conexion de la persona para acabar rechazando el
        video, y el backend lo rechaza igual (CHECK de la migracion 0003).
      */
      if (elegido.kind === 'video' && duracion > MAX_HISTORIA_MS) {
        throw new Error(
          `Las historias admiten hasta ${MAX_HISTORIA_MS / 1000} segundos. ` +
            'Elige otro vídeo o recórtalo antes.',
        );
      }

      const subido = await uploadPostMedia(elegido, avance);
      // Se comprueba justo antes de crear la historia: si se cancelo mientras
      // subia, el archivo queda huerfano pero NO aparece ninguna historia.
      if (cancelado()) throw new PublicacionCancelada();

      await createStory(
        subido,
        elegido.kind === 'video' ? Math.max(1000, duracion) : FOTO_MS,
      );
      setElegido(null);
      // El aviso va DESPUES de salir: sobre una pantalla completa el toast
      // quedaria tapado.
      alSalir();
      toast('Historia publicada');
    });
  }, [elegido, envio, createStory, alSalir]);

  if (!elegido) {
    return (
      <PasoDeCaptura
        duracionMaximaMs={MAX_HISTORIA_MS}
        pie={pie}
        alElegir={setElegido}
        alCerrar={alSalir}
        activo={activo}
      />
    );
  }

  return (
    <View style={styles.raiz}>
      {elegido.kind === 'video' ? (
        <VideoPlayer
          uri={elegido.uri}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          nativeControls={false}
          autoPlay
          loop
        />
      ) : (
        <ExpoImage source={{ uri: elegido.uri }} style={StyleSheet.absoluteFill} contentFit="cover" />
      )}

      <Pressable
        onPress={() => {
          envio.limpiar();
          setElegido(null);
        }}
        hitSlop={12}
        style={styles.volver}
        accessibilityRole="button"
        accessibilityLabel="Elegir otra cosa"
      >
        <Feather name="arrow-left" size={24} color={media.text} />
      </Pressable>

      <View style={styles.pie}>
        <ProgresoDePublicacion
          fase={envio.fase}
          progreso={envio.progreso}
          error={envio.error}
          puedeReintentar={envio.puedeReintentar}
          alReintentar={envio.reintentar}
          alCancelar={envio.cancelar}
        />
        <Button
          label="Compartir en tu historia"
          variant="secondary"
          icon="send"
          onPress={publicar}
          loading={envio.ocupado}
          disabled={envio.ocupado}
        />
        <Text variant="caption" color={media.textMuted} style={styles.nota}>
          Se verá durante 24 horas.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  raiz: { flex: 1, backgroundColor: media.background },
  volver: {
    position: 'absolute',
    top: 54,
    left: spacing.lg,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: media.overlay,
  },
  pie: { position: 'absolute', left: spacing.lg, right: spacing.lg, bottom: 44, gap: spacing.sm },
  nota: { textAlign: 'center' },
});
