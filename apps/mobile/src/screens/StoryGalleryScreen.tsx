import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Dimensions, Pressable, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Image as ExpoImage } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import Feather from '@expo/vector-icons/Feather';

import { Button } from '@/components/Button';
import { useEspacioInferior } from '@/components/espacioInferior';
import { Text } from '@/components/Text';
import { palette, radius, spacing } from '@/theme/tokens';
import { pickImage, type PickedMedia } from '@/services/storage';
import { notify } from '@/lib/confirm';
import { ALTO_SELECTOR } from '@/lib/controlesDeCamara';
import { describeError } from '@/lib/describeError';
import { MAX_HISTORIA_MS } from '@/lib/historias';
import { useTranslation } from '@/i18n/useTranslation';

/** Superficie oscura, como el resto del flujo de captura. */
const media = palette('dark');

/*
  El tope sale de `lib/historias`, no de una copia local. Estaba escrito a mano
  aqui, en el carrete, en el modo historia y en el backend: cuatro numeros que
  habia que cambiar a la vez, y bastaba con olvidar uno para que la camara
  cortara a un tiempo y la subida rechazara a otro.
*/
const MAX_STORY_MS = MAX_HISTORIA_MS;

const COLUMNS = 3;
const GAP = 2;
const TILE = (Dimensions.get('window').width - GAP * (COLUMNS - 1)) / COLUMNS;

/** Cuantos elementos se piden de golpe. */
const PAGE = 60;

/** Alto del enlace secundario del pie («Escribir sin foto»): un toque comodo. */
const ALTO_ALTERNATIVA = 44;

type Props = {
  onSelect: (media: PickedMedia) => void;
  onClose: () => void;
  /** Vuelve a la camara. */
  onOpenCamera: () => void;
  /**
   * Solo videos. Lo usa el modo Reel de Crear: ensenar fotos en una cuadricula
   * de la que no se puede elegir ninguna es peor que no ensenarlas.
   */
  soloVideo?: boolean;
  /**
   * La barra de tipos de publicacion de Crear. Se pinta sobre la cuadricula,
   * abajo del todo: es donde se espera poder cambiar de tipo de publicacion sin
   * salir antes del carrete.
   */
  pie?: React.ReactNode;
  /** Salida secundaria junto al carrete (por ejemplo, «Escribir sin foto»). */
  alternativa?: { etiqueta: string; alPulsar: () => void };
  /**
   * Qué encuadre pide el selector DEL SISTEMA, que es la salida de emergencia
   * cuando la cuadrícula no puede leer el carrete.
   *
   * Estaba fijo en 9:16 —la forma de una historia— para todo el mundo, así que
   * quien llegaba por ahí a crear una PUBLICACIÓN se encontraba el recortador
   * del teléfono exigiéndole una foto vertical de historia. Y por la puerta
   * normal, la cuadrícula, no había recorte ninguno: dos comportamientos
   * distintos para la misma acción según qué permiso tuviera el aparato.
   *
   * `'ninguno'` desactiva el recorte del sistema y deja la foto entera, que es
   * lo que hace la cuadrícula y lo que el muro sabe encuadrar.
   */
  recorte?: [number, number] | 'ninguno';
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
export function StoryGalleryScreen({
  onSelect,
  onClose,
  onOpenCamera,
  soloVideo = false,
  pie,
  alternativa,
  recorte = [9, 16],
}: Props) {
  const { t } = useTranslation();
  /*
    Lo que hay que dejar libre abajo EN ESTE aparato, contando su zona segura.
    Antes estaba escrito en la hoja de estilos como un numero fijo, sin la zona
    segura: 26 px de menos en cualquier telefono con indicador de inicio.
  */
  const espacioInferior = useEspacioInferior();
  /*
    Lo que tapa el pie, para que la cuadricula termine por ENCIMA de el.

    La barra de tipos de publicacion tiene fondo propio: sin este margen las
    ultimas fotos del carrete quedarian debajo y no habria forma de subirlas
    para elegirlas.
  */
  const altoDelPie =
    (pie ? ALTO_SELECTOR : 0) + (alternativa ? ALTO_ALTERNATIVA + spacing.sm : 0);
  const finDeLaCuadricula =
    altoDelPie > 0 ? espacioInferior + altoDelPie + spacing.sm : espacioInferior;
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
          mediaType: soloVideo ? ['video'] : ['photo', 'video'],
          sortBy: ['creationTime'],
        });
        setAssets((prev) => (after ? [...prev, ...page.assets] : page.assets));
        setCursor(page.endCursor);
        setHasMore(page.hasNextPage);
      } finally {
        setLoading(false);
      }
    },
    [soloVideo],
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
      const foto = await pickImage(
        // El mismo trato que por la puerta normal: si aquí no se recorta,
        // tampoco puede recortar la salida de emergencia.
        recorte === 'ninguno' ? { allowsEditing: false } : { aspect: recorte },
      );
      if (foto) onSelect(foto);
    } catch (error) {
      notify(t('media.pickerFailedTitle'), describeError(error, t('common.tryAgain')));
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
      /*
        LAS MEDIDAS VIAJAN. `MediaLibrary` las trae y aqui se tiraban, asi que
        `PickedMedia.width/height` —que existen justo «para la proporcion del
        hueco»— llegaban vacias a todo lo que va despues: la vista previa no
        podia saber como iba a quedar la foto y la pintaba a pantalla completa.
      */
      width: asset.width ?? null,
      height: asset.height ?? null,
    });
  };

  /*
    La barra de tipos de publicacion, sola, para los dos estados sin cuadricula.

    Mientras el carrete carga y cuando falta el permiso no se pintaba. Con la
    barra de secciones debajo no se notaba; sin ella, al abrir el carrete el
    borde de abajo se quedaba vacio un momento y la barra reaparecia despues.
  */
  const barraSola = pie ? (
    <View style={[styles.pie, { bottom: espacioInferior }]} pointerEvents="box-none">
      {pie}
    </View>
  ) : null;

  if (loading) {
    return (
      <View style={styles.root}>
        <View style={[styles.center, styles.lleno]}>
          <ActivityIndicator color={media.text} />
        </View>
        {barraSola}
      </View>
    );
  }

  if (permission && !permission.granted) {
    return (
      <View style={styles.root}>
      <View style={[styles.center, styles.lleno]}>
        <Feather name="image" size={34} color={media.textMuted} />
        <Text variant="body" weight="700" color={media.text} style={styles.deniedTitle}>
          {t('media.noPhotoAccess')}
        </Text>
        <Text variant="secondary" color={media.textMuted} style={styles.deniedBody}>
          {permission.canAskAgain
            ? t('media.grantPhotoPermission')
            : t('media.enablePhotosInSettings')}
        </Text>
        {permission.canAskAgain ? (
          <Button
            label={t('media.givePermission')}
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
          label={t('media.useSystemPicker')}
          variant="secondary"
          icon="folder"
          onPress={() => void elegirConElSistema()}
          style={styles.deniedCta}
        />

        <Pressable onPress={onClose} hitSlop={10} style={styles.deniedLink}>
          <Text variant="secondary" color={media.textMuted}>
            {t('common.cancel')}
          </Text>
        </Pressable>
      </View>
      {barraSola}
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={onClose} hitSlop={12} style={styles.headerButton} accessibilityRole="button" accessibilityLabel={t('common.close')}>
          <Feather name="x" size={24} color={media.text} />
        </Pressable>
        <Text variant="body" weight="800" color={media.text}>
          {t('stories.addTitle')}
        </Text>
        <Pressable onPress={onOpenCamera} hitSlop={12} style={styles.headerButton} accessibilityRole="button" accessibilityLabel={t('media.openCamera')}>
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
            {t('media.limitedAccess')}
          </Text>
        </Pressable>
      ) : null}

      {assets.length === 0 ? (
        <View style={[styles.center, styles.lleno]}>
          <Text variant="secondary" color={media.textMuted}>
            {t('media.noMediaOnDevice')}
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
          contentContainerStyle={{ paddingBottom: finDeLaCuadricula }}
          renderItem={({ item }) => {
            const esVideo = item.mediaType === 'video';
            const largo = esVideo && item.duration * 1000 > MAX_STORY_MS;
            return (
              <Pressable
                onPress={() => choose(item)}
                style={styles.tile}
                accessibilityRole="button"
                accessibilityLabel={esVideo ? t('video.video') : t('gallery.photo')}
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

      {/*
        El pie va por ENCIMA de la cuadricula y no dentro del desplazamiento:
        tiene que seguir ahi despues de bajar cien fotos.
      */}
      {pie || alternativa ? (
        <View style={[styles.pie, { bottom: espacioInferior }]} pointerEvents="box-none">
          {alternativa ? (
            <Pressable
              onPress={alternativa.alPulsar}
              hitSlop={8}
              accessibilityRole="button"
              style={styles.alternativa}
            >
              <Text variant="secondary" weight="700" color={media.text}>
                {alternativa.etiqueta}
              </Text>
            </Pressable>
          ) : null}
          {pie}
        </View>
      ) : null}
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
  pie: {
    position: 'absolute',
    left: 0,
    right: 0,
    // `bottom` lo pone el componente: sale de `useEspacioInferior`, que ya
    // cuenta la zona segura del aparato.
    gap: spacing.sm,
  },
  alternativa: {
    alignSelf: 'center',
    minHeight: ALTO_ALTERNATIVA,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    // Va encima de las fotos del carrete: sin fondo propio, sobre una foto
    // clara la letra blanca no se lee.
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: media.glassBorder,
    backgroundColor: media.overlay,
  },
  center: { alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },
  lleno: { flex: 1 },
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
