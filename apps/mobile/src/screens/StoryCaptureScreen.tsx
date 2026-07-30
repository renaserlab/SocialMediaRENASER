import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import type { CameraType, FlashMode } from 'expo-camera';
import { Image as ExpoImage } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import { haptics } from '@/lib/haptics';
import { palette, radius, spacing } from '@/theme/tokens';
import type { PickedMedia } from '@/services/storage';

/** La camara es una superficie oscura en ambos temas, como los Shorts. */
const media = palette('dark');

/** Tope de una historia; coincide con el CHECK de la migracion 0003. */
const MAX_STORY_MS = 15_000;

type Props = {
  /** Se llama con lo capturado o elegido. */
  onCaptured: (media: PickedMedia) => void;
  /** Abre la cuadricula del carrete. */
  onOpenGallery: () => void;
  onClose: () => void;
  /** Miniatura de la ultima foto del carrete, para el acceso a la galeria. */
  lastPhotoUri?: string | null;
};

/**
 * Camara de historias a pantalla completa.
 *
 * Un toque hace foto; mantener pulsado graba video, como en Instagram. El
 * limite de 15 s lo aplica la propia camara (`maxDuration`), no una
 * comprobacion posterior: asi no se graba de mas para descartarlo despues.
 */
export function StoryCaptureScreen({
  onCaptured,
  onOpenGallery,
  onClose,
  lastPhotoUri,
}: Props) {
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  // El microfono solo hace falta para el video, asi que se pide al grabar y no
  // al abrir: pedir todo de golpe al entrar hace que se rechace mas.
  const [micPermission, requestMicPermission] = useMicrophonePermissions();

  const [facing, setFacing] = useState<CameraType>('back');
  const [flash, setFlash] = useState<FlashMode>('off');
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);

  /**
   * Distingue el toque de la pulsacion larga.
   *
   * `onLongPress` de Pressable no sirve aqui: necesitamos empezar a grabar al
   * mantener Y parar al soltar, y eso son dos eventos distintos.
   */
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didRecord = useRef(false);

  // Anillo de progreso mientras se graba.
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!permission?.granted && permission?.canAskAgain) {
      void requestPermission();
    }
  }, [permission, requestPermission]);

  const stopProgress = useCallback(() => {
    progress.stopAnimation();
    progress.setValue(0);
  }, [progress]);

  const takePhoto = useCallback(async () => {
    if (!cameraRef.current || busy) return;
    setBusy(true);
    try {
      haptics.medium();
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.8 });
      if (photo?.uri) {
        onCaptured({ uri: photo.uri, kind: 'image', mimeType: 'image/jpeg', name: null });
      }
    } catch {
      notify('No se pudo tomar la foto', 'Inténtalo de nuevo.');
    } finally {
      setBusy(false);
    }
  }, [busy, onCaptured]);

  const startRecording = useCallback(async () => {
    if (!cameraRef.current || busy) return;
    // El video lleva sonido: sin permiso de microfono se graba mudo y nadie
    // entiende por que. Se pide justo aqui, cuando ya tiene sentido.
    if (!micPermission?.granted) {
      const asked = await requestMicPermission();
      if (!asked.granted) {
        notify(
          'Falta el micrófono',
          'Sin permiso de micrófono el vídeo se grabaría sin sonido. Actívalo en Ajustes del teléfono.',
        );
        return;
      }
    }
    didRecord.current = true;
    setRecording(true);
    haptics.medium();
    Animated.timing(progress, {
      toValue: 1,
      duration: MAX_STORY_MS,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start();
    try {
      const video = await cameraRef.current.recordAsync({
        maxDuration: MAX_STORY_MS / 1000,
      });
      if (video?.uri) {
        onCaptured({ uri: video.uri, kind: 'video', mimeType: 'video/mp4', name: null });
      }
    } catch {
      notify('No se pudo grabar', 'Inténtalo de nuevo.');
    } finally {
      setRecording(false);
      stopProgress();
    }
  }, [busy, micPermission, requestMicPermission, onCaptured, progress, stopProgress]);

  const onPressIn = () => {
    didRecord.current = false;
    holdTimer.current = setTimeout(() => {
      void startRecording();
    }, 350);
  };

  const onPressOut = () => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (didRecord.current) {
      // Se solto: se corta la grabacion y `recordAsync` resuelve con el video.
      cameraRef.current?.stopRecording();
      return;
    }
    void takePhoto();
  };

  // Sin permiso no se puede ni mostrar la vista previa: se explica y se ofrece
  // la galeria, que no necesita camara.
  if (permission && !permission.granted) {
    return (
      <View style={[styles.root, styles.center]}>
        <Feather name="camera-off" size={34} color={media.textMuted} />
        <Text variant="body" weight="700" color={media.text} style={styles.deniedTitle}>
          Sin acceso a la cámara
        </Text>
        <Text variant="secondary" color={media.textMuted} style={styles.deniedBody}>
          {permission.canAskAgain
            ? 'Concede el permiso para tomar fotos y vídeos.'
            : 'Actívalo en Ajustes del teléfono → Z → Cámara.'}
        </Text>
        {permission.canAskAgain ? (
          <Button label="Dar permiso" variant="secondary" onPress={() => void requestPermission()} style={styles.deniedCta} />
        ) : null}
        <Pressable onPress={onOpenGallery} hitSlop={10} style={styles.deniedLink}>
          <Text variant="secondary" weight="700" color={media.text}>
            Elegir de la galería
          </Text>
        </Pressable>
        <Pressable onPress={onClose} hitSlop={10} style={styles.deniedLink}>
          <Text variant="secondary" color={media.textMuted}>
            Cancelar
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing={facing}
        flash={flash}
        mode={recording ? 'video' : 'picture'}
      />

      {/* Barra superior: cerrar y flash. */}
      <View style={styles.topBar} pointerEvents="box-none">
        <Pressable onPress={onClose} hitSlop={12} style={styles.roundButton} accessibilityRole="button" accessibilityLabel="Cerrar">
          <Feather name="x" size={24} color={media.text} />
        </Pressable>
        <Pressable
          onPress={() => setFlash((f) => (f === 'off' ? 'on' : 'off'))}
          hitSlop={12}
          style={styles.roundButton}
          accessibilityRole="button"
          accessibilityLabel={flash === 'off' ? 'Activar flash' : 'Desactivar flash'}
        >
          {/* El estado no se distingue solo por color: cambia el icono. */}
          <Feather name={flash === 'off' ? 'zap-off' : 'zap'} size={22} color={media.text} />
        </Pressable>
      </View>

      {recording ? (
        <View style={styles.recordingPill}>
          <View style={styles.recordingDot} />
          <Text variant="secondary" weight="700" color={media.text}>
            Grabando
          </Text>
        </View>
      ) : null}

      {/* Barra inferior: galeria, disparador y girar camara. */}
      <View style={styles.bottomBar} pointerEvents="box-none">
        <Pressable
          onPress={onOpenGallery}
          style={styles.thumb}
          accessibilityRole="button"
          accessibilityLabel="Elegir de la galería"
        >
          {lastPhotoUri ? (
            <ExpoImage source={{ uri: lastPhotoUri }} style={styles.thumbImage} contentFit="cover" />
          ) : (
            <Feather name="image" size={20} color={media.text} />
          )}
        </Pressable>

        <Pressable
          onPressIn={onPressIn}
          onPressOut={onPressOut}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Tocar para foto, mantener para vídeo"
          style={styles.shutterHit}
        >
          <Animated.View
            style={[
              styles.shutterRing,
              {
                borderColor: media.text,
                transform: [{ scale: recording ? 1.15 : 1 }],
              },
            ]}
          >
            {busy ? (
              <ActivityIndicator color={media.background} />
            ) : (
              <View
                style={[
                  styles.shutterCore,
                  recording
                    ? { backgroundColor: media.text, borderRadius: radius.sm, width: 30, height: 30 }
                    : { backgroundColor: media.text },
                ]}
              />
            )}
          </Animated.View>
        </Pressable>

        <Pressable
          onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))}
          hitSlop={12}
          style={styles.roundButton}
          accessibilityRole="button"
          accessibilityLabel="Cambiar de cámara"
        >
          <Feather name="refresh-cw" size={22} color={media.text} />
        </Pressable>
      </View>

      <Text variant="secondary" color={media.textMuted} style={styles.hint}>
        Toca para una foto · Mantén para grabar
      </Text>
    </View>
  );
}

/** Ultima foto del carrete, para la miniatura. Null si no hay permiso. */
export async function lastGalleryPhoto(): Promise<string | null> {
  try {
    const permission = await MediaLibrary.getPermissionsAsync();
    if (!permission.granted) return null;
    const page = await MediaLibrary.getAssetsAsync({ first: 1, sortBy: ['creationTime'] });
    return page.assets[0]?.uri ?? null;
  } catch {
    return null;
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: media.background },
  center: { alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },
  deniedTitle: { marginTop: spacing.lg },
  deniedBody: { textAlign: 'center', marginTop: spacing.sm, lineHeight: 20 },
  deniedCta: { marginTop: spacing.xl, minWidth: 200 },
  deniedLink: { marginTop: spacing.lg, minHeight: 44, justifyContent: 'center' },
  topBar: {
    position: 'absolute',
    top: 54,
    left: spacing.lg,
    right: spacing.lg,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  roundButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: media.overlay,
  },
  recordingPill: {
    position: 'absolute',
    top: 108,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: media.overlay,
  },
  recordingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: media.danger },
  bottomBar: {
    position: 'absolute',
    bottom: 58,
    left: spacing.xl,
    right: spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  thumb: {
    width: 44,
    height: 44,
    borderRadius: radius.sm,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: media.overlay,
    borderWidth: 1,
    borderColor: media.textMuted,
  },
  thumbImage: { width: '100%', height: '100%' },
  shutterHit: { alignItems: 'center', justifyContent: 'center' },
  shutterRing: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterCore: { width: 58, height: 58, borderRadius: 29 },
  hint: {
    position: 'absolute',
    bottom: 24,
    alignSelf: 'center',
  },
});
