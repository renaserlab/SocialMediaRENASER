import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Feather } from '@expo/vector-icons';

import { Button } from '@/components/Button';
import { useEspacioInferior } from '@/components/espacioInferior';
import { ProgresoDePublicacion } from '@/components/crear/ProgresoDePublicacion';
import { PasoDeCaptura } from '@/components/crear/PasoDeCaptura';
import { Text } from '@/components/Text';
import { VideoPlayer } from '@/components/VideoPlayer';
import { usePublicacion, PublicacionCancelada } from '@/hooks/usePublicacion';
import {
  FOTO_MS,
  MAX_HISTORIA_MS,
  duracionMedida,
  revisarDuracionDeHistoria,
} from '@/lib/historias';
import { toast } from '@/lib/toast';
import { readVideoMetadata } from '@/services/mediaCompressor';
import { uploadPostMedia, type PickedMedia } from '@/services/storage';
import { useAppStore } from '@/store/useAppStore';
import { palette, spacing } from '@/theme/tokens';
import { useTranslation } from '@/i18n/useTranslation';

const media = palette('dark');

/*
  El tope de una historia y el tiempo de una foto viven en `lib/historias`, no
  aqui. Estaban repetidos a mano en tres pantallas y en el backend, y con cinco
  copias del mismo numero basta con cambiar cuatro para que la camara corte a un
  tiempo y el control de subida rechace a otro.
*/
export { MAX_HISTORIA_MS } from '@/lib/historias';

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
  const { t } = useTranslation();
  const createStory = useAppStore((state) => state.createStory);
  /*
    El pie se apoya en la barra flotante, no en un numero.

    Estaba en `bottom: 44` y la capsula de secciones ocupa entre 78 y 104 px
    segun el aparato: el boton de publicar quedaba DEBAJO de ella siempre, y
    como la barra se pinta encima y se queda el toque, pulsarlo cambiaba de
    seccion. Ahora la medida sale del mismo sitio que la dibuja.
  */
  const espacioInferior = useEspacioInferior();
  const [elegido, setElegido] = useState<PickedMedia | null>(null);
  const envio = usePublicacion();

  const publicar = useCallback(() => {
    if (!elegido) return;

    void envio.ejecutar(async ({ avance, cancelado }) => {
      /*
        SE MIDE EL ARCHIVO, no se cree lo que diga quien lo eligio.

        Antes el limite se comprobaba contra `elegido.durationMs`, que es lo que
        REPORTA el selector, y ese dato falta a menudo. Cuando faltaba valia
        cero y la comparacion `0 > tope` daba falso: un video de cinco minutos
        pasaba el control sin que nadie lo mirara. Aqui se lee ademas la
        duracion del propio archivo y manda la mayor de las dos.

        Y se hace ANTES de subir: comprobarlo despues seria gastar la conexion
        de la persona para acabar rechazandola.
      */
      let duracion: number | null = elegido.durationMs ?? null;
      if (elegido.kind === 'video') {
        const delArchivo = await readVideoMetadata(elegido.uri).catch(() => null);
        duracion = duracionMedida(elegido.durationMs, delArchivo?.durationS
          ? delArchivo.durationS * 1000
          : null);
        const decision = revisarDuracionDeHistoria(duracion, t);
        if (decision.estado !== 'cabe') throw new Error(decision.mensaje);
        duracion = decision.durationMs;
      }

      const subido = await uploadPostMedia(elegido, avance);
      // Se comprueba justo antes de crear la historia: si se cancelo mientras
      // subia, el archivo queda huerfano pero NO aparece ninguna historia.
      if (cancelado()) throw new PublicacionCancelada();

      await createStory(
        subido,
        elegido.kind === 'video' && duracion ? duracion : FOTO_MS,
      );
      setElegido(null);
      // El aviso va DESPUES de salir: sobre una pantalla completa el toast
      // quedaria tapado.
      alSalir();
      toast(t('create.storyPublished'));
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
        accessibilityLabel={t('create.chooseSomethingElse')}
      >
        <Feather name="arrow-left" size={24} color={media.text} />
      </Pressable>

      <View style={[styles.pie, { bottom: espacioInferior }]}>
        <ProgresoDePublicacion
          fase={envio.fase}
          progreso={envio.progreso}
          error={envio.error}
          puedeReintentar={envio.puedeReintentar}
          alReintentar={envio.reintentar}
          alCancelar={envio.cancelar}
        />
        <Button
          label={t('create.shareToStory')}
          variant="secondary"
          icon="send"
          onPress={publicar}
          loading={envio.ocupado}
          disabled={envio.ocupado}
        />
        <Text variant="caption" color={media.textMuted} style={styles.nota}>
          {t('create.storyLasts24h')}
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
  // `bottom` lo pone el componente: depende de cuanto ocupe la barra flotante.
  pie: { position: 'absolute', left: spacing.lg, right: spacing.lg, gap: spacing.sm },
  nota: { textAlign: 'center' },
});
