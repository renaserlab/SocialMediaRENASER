import React from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useVideoPlayer, VideoView } from 'expo-video';

import { ImageViewer } from '@/components/ImageViewer';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import { palette, spacing } from '@/theme/tokens';
import type { MessageAttachment } from '@/types';

/** El visor es siempre oscuro, como el de fotos: la imagen manda. */
const media = palette('dark');

/** Una acción de la barra de arriba del visor. */
export type AccionDeVisor = {
  icono: keyof typeof Feather.glyphMap;
  etiqueta: string;
  alPulsar: () => void;
  /** Se pinta en rojo: borrar. */
  peligro?: boolean;
};

type Props = {
  /** El adjunto que se está viendo. `null` mantiene el visor cerrado. */
  adjunto: MessageAttachment | null;
  /** Quién lo envió, tal como se lee en el chat. */
  autor: string;
  /** Cuándo, ya en texto. */
  fecha?: string;
  acciones?: AccionDeVisor[];
  /** Lo que va abajo del todo: responder y reaccionar. */
  pie?: React.ReactNode;
  onClose: () => void;
};

/**
 * La barra de arriba: volver, quién lo envió y cuándo, y las acciones.
 *
 * LO QUE FALTABA (visto en teléfono el 10/10/2026): al ampliar una foto de un
 * grupo no se sabía de quién era ni se podía hacer nada con ella.
 */
function BarraDeVisor({
  autor,
  fecha,
  acciones,
  onClose,
}: Pick<Props, 'autor' | 'fecha' | 'acciones' | 'onClose'>) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.barra, { paddingTop: insets.top + spacing.sm }]}>
      <Pressable
        onPress={onClose}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel={t('common.back')}
        style={styles.boton}
      >
        <Feather name="arrow-left" size={24} color={media.text} />
      </Pressable>
      <View style={styles.quien}>
        <Text numberOfLines={1} weight="700" color={media.text} style={styles.autor}>
          {autor}
        </Text>
        {fecha ? (
          <Text numberOfLines={1} color={media.textMuted} style={styles.fecha}>
            {fecha}
          </Text>
        ) : null}
      </View>
      {(acciones ?? []).map((accion) => (
        <Pressable
          key={accion.etiqueta}
          onPress={accion.alPulsar}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={accion.etiqueta}
          style={styles.boton}
        >
          <Feather
            name={accion.icono}
            size={22}
            color={accion.peligro ? media.danger : media.text}
          />
        </Pressable>
      ))}
    </View>
  );
}

/**
 * El vídeo, DENTRO de la aplicación.
 *
 * Antes un vídeo del chat se abría fuera, en el navegador: la aplicación no
 * tenía dónde reproducirlo. Aquí se reproduce con los controles del propio
 * teléfono (pausa, avance, pantalla completa).
 *
 * Es un componente aparte para que el reproductor nativo solo exista mientras
 * hay un vídeo abierto: `useVideoPlayer` lo crea al montarse y lo suelta al
 * desmontarse.
 */
function Video({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.play();
  });
  return (
    <VideoView
      style={styles.video}
      player={player}
      contentFit="contain"
      nativeControls
      allowsPictureInPicture={false}
    />
  );
}

/**
 * Ver a pantalla completa una foto o un vídeo del chat, sabiendo de quién es.
 *
 * Una foto usa el visor de siempre (`ImageViewer`, con su pinza y su doble
 * toque) y solo le cambia la barra de arriba. Un vídeo se reproduce aquí.
 */
export function VisorDeAdjunto({ adjunto, autor, fecha, acciones, pie, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const barra = <BarraDeVisor autor={autor} fecha={fecha} acciones={acciones} onClose={onClose} />;

  if (adjunto?.kind === 'video' && adjunto.url) {
    return (
      <Modal visible transparent={false} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
        <View style={styles.raiz}>
          <Video uri={adjunto.url} />
          <View style={styles.encima}>{barra}</View>
          {pie ? <View style={[styles.pie, { paddingBottom: insets.bottom + spacing.sm }]}>{pie}</View> : null}
        </View>
      </Modal>
    );
  }

  return (
    <ImageViewer
      uri={adjunto?.kind === 'image' ? adjunto.url ?? null : null}
      // La misma clave de disco que usa la burbuja: la ruta del archivo. Lo
      // que ya se vio en el chat sale al instante, sin volver a bajarlo.
      claveDeCache={
        adjunto?.kind === 'image' && adjunto.storagePath && adjunto.url?.startsWith('http')
          ? adjunto.storagePath
          : undefined
      }
      caption={adjunto?.fileName ?? undefined}
      onClose={onClose}
      cabecera={barra}
      pie={pie}
    />
  );
}

const styles = StyleSheet.create({
  raiz: { flex: 1, backgroundColor: media.background, justifyContent: 'center' },
  video: { width: '100%', height: '100%' },
  encima: { position: 'absolute', top: 0, left: 0, right: 0 },
  pie: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: spacing.md },
  barra: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  boton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  quien: { flex: 1, minWidth: 0 },
  autor: { fontSize: 16 },
  fecha: { fontSize: 12 },
});
