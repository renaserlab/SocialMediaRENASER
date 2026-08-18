import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Dimensions, Pressable, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Image as ExpoImage } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import { Feather } from '@expo/vector-icons';

import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { palette, radius, spacing } from '@/theme/tokens';
import { pickImage, type PickedMedia } from '@/services/storage';
import { notify } from '@/lib/confirm';
import { describeError } from '@/lib/describeError';

/** Superficie oscura, como el resto del flujo de captura. */
const media = palette('dark');

/** Tope de una historia; coincide con el CHECK de la migracion 0003. */
const MAX_STORY_MS = 15_000;

const COLUMNS = 3;
const GAP = 2;
const TILE = (Dimensions.get('window').width - GAP * (COLUMNS - 1)) / COLUMNS;

/** Cuantos elementos se piden de golpe. */
const PAGE = 60;

type Props = {
  onSelect: (media: PickedMedia) => void;
  onClose: () => void;
  /** Vuelve a la camara. */
  onOpenCamera: () => void;
};

/**
 * Cuadricula del carrete, dentro de la app.
 *
 * Sustituye al selector del sistema para que elegir una historia se parezca a
 * lo que la gente ya conoce de Instagram: se ve el carrete completo de un
 * vistazo, en vez de una hoja con tres opciones.
 *
 * Solo muestra fotos y videos, y marca la duracion de estos ultimos: una
 * historia admite 15 s, asi que conviene saberlo ANTES de elegir y no despues
 * de que el aviso lo rechace.
 */
export function StoryGalleryScreen({ onSelect, onClose, onOpenCamera }: Props) {
  const [permission, setPermission] = useState<MediaLibrary.PermissionResponse | null>(null);
  const [assets, setAssets] = useState<MediaLibrary.Asset[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);

  const ask = useCallback(async () => {
    // `writeOnly: false` porque hay que LEER el carrete. En iOS el permiso
    // puede ser 'limited': entonces solo se ven las fotos que la persona haya
    // elegido compartir, y eso es correcto, no un error.
    const result = await MediaLibrary.requestPermissionsAsync(false);
    setPermission(result);
    return result.granted;
  }, []);

  const load = useCallback(
    async (after?: string) => {
      try {
        const page = await MediaLibrary.getAssetsAsync({
          first: PAGE,
          after,
          mediaType: ['photo', 'video'],
          sortBy: ['creationTime'],
        });
        setAssets((prev) => (after ? [...prev, ...page.assets] : page.assets));
        setCursor(page.endCursor);
        setHasMore(page.hasNextPage);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void (async () => {
      const granted = await ask();
      if (granted) await load();
      else setLoading(false);
    })();
  }, [ask, load]);

  /**
   * Elige usando el selector del propio telefono.
   *
   * Alternativa para cuando la cuadricula no puede cargar: sin permiso, o en
   * Android 12 y anteriores, donde leer el carrete exigiria un permiso de
   * almacenamiento que la aplicacion no pide.
   */
  const elegirConElSistema = async () => {
    try {
      const foto = await pickImage({ aspect: [9, 16] });
      if (foto) onSelect(foto);
    } catch (error) {
      notify('No se pudo abrir el selector', describeError(error, 'Inténtalo de nuevo.'));
    }
  };

  const choose = (asset: MediaLibrary.Asset) => {
    const esVideo = asset.mediaType === 'video';
    onSelect({
      uri: asset.uri,
      kind: esVideo ? 'video' : 'image',
      mimeType: null,
      name: asset.filename,
      // La duracion llega en SEGUNDOS; el resto de la app trabaja en ms.
      durationMs: esVideo ? Math.round(asset.duration * 1000) : null,
    });
  };

  if (loading) {
    return (
      <View style={[styles.root, styles.center]}>
        <ActivityIndicator color={media.text} />
      </View>
    );
  }

  if (permission && !permission.granted) {
    return (
      <View style={[styles.root, styles.center]}>
        <Feather name="image" size={34} color={media.textMuted} />
        <Text variant="body" weight="700" color={media.text} style={styles.deniedTitle}>
          Sin acceso a tus fotos
        </Text>
        <Text variant="secondary" color={media.textMuted} style={styles.deniedBody}>
          {permission.canAskAgain
            ? 'Concede el permiso para elegir una foto o un vídeo.'
            : 'Actívalo en Ajustes del teléfono → Z → Fotos.'}
        </Text>
        {permission.canAskAgain ? (
          <Button
            label="Dar permiso"
            variant="secondary"
            onPress={() => void (async () => {
              if (await ask()) await load();
            })()}
            style={styles.deniedCta}
          />
        ) : null}

        {/*
          Salida por el selector del sistema.

          No es solo un consuelo para quien rechaza el permiso: en Android 12 y
          anteriores leer el carrete exige READ_EXTERNAL_STORAGE, que la
          aplicacion bloquea a proposito —Google Play mira con lupa el acceso
          amplio al almacenamiento—. En esos telefonos la cuadricula NUNCA va a
          poder cargar, y sin esta alternativa se quedarian sin forma de elegir
          una foto salvo hacerla con la camara.

          El selector del sistema no necesita ese permiso porque la eleccion
          ocurre fuera de la aplicacion: solo se recibe lo que la persona elige.
        */}
        <Button
          label="Elegir con el selector del teléfono"
          variant="secondary"
          icon="folder"
          onPress={() => void elegirConElSistema()}
          style={styles.deniedCta}
        />

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
      <View style={styles.header}>
        <Pressable onPress={onClose} hitSlop={12} style={styles.headerButton} accessibilityRole="button" accessibilityLabel="Cerrar">
          <Feather name="x" size={24} color={media.text} />
        </Pressable>
        <Text variant="body" weight="800" color={media.text}>
          Agregar a tu historia
        </Text>
        <Pressable onPress={onOpenCamera} hitSlop={12} style={styles.headerButton} accessibilityRole="button" accessibilityLabel="Abrir la cámara">
          <Feather name="camera" size={22} color={media.text} />
        </Pressable>
      </View>

      {/*
        En iOS el permiso puede ser 'limited': solo se ven las fotos que la
        persona eligio compartir. Sin decirlo, parece que falta la mitad del
        carrete y que la app se ha equivocado.
      */}
      {permission?.accessPrivileges === 'limited' ? (
        <Pressable
          onPress={() => void MediaLibrary.presentPermissionsPickerAsync()}
          style={styles.limited}
          accessibilityRole="button"
        >
          <Feather name="info" size={15} color={media.text} />
          <Text variant="secondary" color={media.text} style={{ flex: 1 }}>
            Solo ves las fotos que compartiste. Toca para elegir más.
          </Text>
        </Pressable>
      ) : null}

      {assets.length === 0 ? (
        <View style={[styles.center, { flex: 1 }]}>
          <Text variant="secondary" color={media.textMuted}>
            No hay fotos ni vídeos en este teléfono.
          </Text>
        </View>
      ) : (
        <FlashList
          data={assets}
          numColumns={COLUMNS}
          keyExtractor={(item) => item.id}
          onEndReached={() => {
            if (hasMore && cursor) void load(cursor);
          }}
          onEndReachedThreshold={0.6}
          renderItem={({ item }) => {
            const esVideo = item.mediaType === 'video';
            const largo = esVideo && item.duration * 1000 > MAX_STORY_MS;
            return (
              <Pressable
                onPress={() => choose(item)}
                style={styles.tile}
                accessibilityRole="button"
                accessibilityLabel={esVideo ? 'Vídeo' : 'Foto'}
              >
                <ExpoImage
                  source={{ uri: item.uri }}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                  // El carrete puede tener miles: sin cache se redescargan al
                  // desplazarse arriba y abajo.
                  cachePolicy="memory-disk"
                  transition={80}
                />
                {esVideo ? (
                  <View style={styles.duration}>
                    <Feather name="video" size={11} color={media.text} />
                    <Text variant="secondary" color={media.text} style={styles.durationText}>
                      {formatDuration(item.duration)}
                    </Text>
                  </View>
                ) : null}
                {/*
                  Se avisa ANTES de elegir, no despues: un video largo se puede
                  seleccionar igual, pero conviene saber que habra que recortarlo.
                */}
                {largo ? (
                  <View style={styles.tooLong}>
                    <Text variant="secondary" color={media.text} style={styles.tooLongText}>
                      Más de {MAX_STORY_MS / 1000}s
                    </Text>
                  </View>
                ) : null}
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: media.background },
  center: { alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },
  deniedTitle: { marginTop: spacing.lg },
  deniedBody: { textAlign: 'center', marginTop: spacing.sm, lineHeight: 20 },
  deniedCta: { marginTop: spacing.xl, minWidth: 200 },
  deniedLink: { marginTop: spacing.lg, minHeight: 44, justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: 54,
    paddingBottom: spacing.md,
  },
  headerButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  limited: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: media.border,
  },
  tile: {
    width: TILE,
    height: TILE,
    marginBottom: GAP,
    marginRight: GAP,
    backgroundColor: media.surface,
    overflow: 'hidden',
  },
  duration: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: media.overlay,
  },
  durationText: { fontSize: 10 },
  tooLong: {
    position: 'absolute',
    top: 4,
    left: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: media.overlay,
    borderWidth: 1,
    borderColor: media.textMuted,
  },
  tooLongText: { fontSize: 9 },
});
