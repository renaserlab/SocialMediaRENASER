import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { VideoPlayer } from '@/components/VideoPlayer';
import { notify } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import {
  StoryCaptureScreen,
  lastGalleryPhoto,
} from '@/screens/StoryCaptureScreen';
import { StoryGalleryScreen } from '@/screens/StoryGalleryScreen';
import { uploadPostMedia, type PickedMedia } from '@/services/storage';
import { useAppStore } from '@/store/useAppStore';
import { palette, radius, spacing } from '@/theme/tokens';

const media = palette('dark');

/** Tope de una historia; coincide con el CHECK de la migracion 0003. */
const MAX_STORY_MS = 15_000;
/** Lo que dura una foto en el visor. */
const PHOTO_MS = 5_000;

type Paso = 'camara' | 'galeria' | 'revision';

/**
 * Flujo completo de crear una historia, al estilo de Instagram.
 *
 * Tres pasos en una sola pantalla, sin cambiar de ruta: camara → galeria →
 * revision. Mantenerlo en una ruta evita que el boton de atras del telefono
 * deshaga el flujo a medias y deje una captura huerfana.
 */
export function NewStoryScreen() {
  const router = useRouter();
  const createStory = useAppStore((state) => state.createStory);

  const [paso, setPaso] = useState<Paso>('camara');
  const [elegido, setElegido] = useState<PickedMedia | null>(null);
  const [subiendo, setSubiendo] = useState(false);
  const [ultimaFoto, setUltimaFoto] = useState<string | null>(null);

  // Miniatura del acceso a la galeria. Si no hay permiso queda en null y se
  // muestra un icono; no es un error que deba interrumpir nada.
  useEffect(() => {
    void lastGalleryPhoto().then(setUltimaFoto);
  }, []);

  const salir = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/home' as never);
  };

  const alElegir = (elegida: PickedMedia) => {
    setElegido(elegida);
    setPaso('revision');
  };

  const publicar = async () => {
    if (!elegido) return;

    const duracion = elegido.durationMs ?? 0;
    if (elegido.kind === 'video' && duracion > MAX_STORY_MS) {
      notify(
        'El vídeo es muy largo',
        `Las historias admiten hasta ${MAX_STORY_MS / 1000} segundos. Elige otro o recórtalo antes.`,
      );
      return;
    }

    setSubiendo(true);
    try {
      const subido = await uploadPostMedia(elegido);
      await createStory(
        subido,
        elegido.kind === 'video' ? Math.max(1000, duracion) : PHOTO_MS,
      );
      // El aviso va DESPUES de salir: sobre esta pantalla a pantalla completa
      // el toast quedaria tapado.
      salir();
      toast('Historia publicada');
    } catch (error) {
      notify(
        'No se pudo publicar',
        error instanceof Error ? error.message : 'Inténtalo de nuevo.',
      );
    } finally {
      setSubiendo(false);
    }
  };

  if (paso === 'camara') {
    return (
      <StoryCaptureScreen
        onCaptured={alElegir}
        onOpenGallery={() => setPaso('galeria')}
        onClose={salir}
        lastPhotoUri={ultimaFoto}
      />
    );
  }

  if (paso === 'galeria') {
    return (
      <StoryGalleryScreen
        onSelect={alElegir}
        onClose={salir}
        onOpenCamera={() => setPaso('camara')}
      />
    );
  }

  // Revision: se ve lo elegido a pantalla completa antes de publicar.
  return (
    <View style={styles.root}>
      {elegido?.kind === 'video' ? (
        <VideoPlayer
          uri={elegido.uri}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          nativeControls={false}
          autoPlay
          loop
        />
      ) : elegido ? (
        <ExpoImage source={{ uri: elegido.uri }} style={StyleSheet.absoluteFill} contentFit="cover" />
      ) : null}

      <Pressable
        onPress={() => {
          setElegido(null);
          setPaso('camara');
        }}
        hitSlop={12}
        style={styles.back}
        accessibilityRole="button"
        accessibilityLabel="Volver a la cámara"
      >
        <Feather name="arrow-left" size={24} color={media.text} />
      </Pressable>

      <View style={styles.footer}>
        {subiendo ? (
          <View style={styles.uploading}>
            <ActivityIndicator color={media.text} />
            <Text variant="secondary" color={media.text}>
              Publicando…
            </Text>
          </View>
        ) : (
          <Button
            label="Compartir en tu historia"
            variant="secondary"
            icon="send"
            onPress={() => void publicar()}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: media.background },
  back: {
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
  footer: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: 44,
  },
  uploading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    minHeight: 48,
    borderRadius: radius.md,
    backgroundColor: media.overlay,
  },
});
