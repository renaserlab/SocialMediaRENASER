import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { SegmentedControl } from '@/components/SegmentedControl';
import { Text } from '@/components/Text';
import { VideoTile } from '@/components/VideoTile';
import { assets } from '@/data/assets';
import { GRID_GAP, GRID_COLUMNS, gridItemSize } from '@/lib/gridLayout';
import { miniaturaDePublicacion } from '@/lib/miniaturaDePublicacion';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Post } from '@/types';
import { useTranslation } from '@/i18n/useTranslation';

type Props = {
  gallery: Post[];
  /** Audios publicados. Ya no se muestran como pestaña, pero se conservan
   *  para el podcast del perfil (siguiente iteración). */
  audios?: Post[];
  loading: boolean;
  error: string | null;
  /** Texto del estado vacío; cambia entre perfil propio y ajeno. */
  emptyHint?: string;
};

/**
 * Cuantas celdas vacias se dibujan mientras llegan las publicaciones. Tres
 * filas: lo que se ve sin desplazar en un telefono.
 */
const CELDAS_DE_ESPERA = GRID_COLUMNS * 3;

/**
 * Cuantas celdas se descargan con prioridad. Cuatro filas: lo que cabe en
 * pantalla mas un poco de margen para el primer desplazamiento.
 */
const PRIMERAS_VISIBLES = GRID_COLUMNS * 4;

/**
 * Galeria de un perfil: cuadricula de fotos/videos y lista de audios.
 *
 * Antes eran seis imagenes fijas del paquete de demo, asi que un perfil real
 * mostraba contenido que no era suyo (y en tema oscuro parecian recuadros
 * vacios). Ahora sale lo que ha publicado esa persona.
 */
export function ProfileGallery({ gallery, loading, error, emptyHint }: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();

  /*
    El lado de cada celda se calcula midiendo el contenedor, en pixeles.

    Antes se definia con un ancho en porcentaje y la altura deducida de la
    proporcion, y eso no se resuelve igual en el navegador que en el movil: en
    el navegador salia bien, y en la aplicacion instalada las celdas se
    quedaban sin altura. El perfil anunciaba «3 publicaciones» y debajo no
    habia nada, ni las fotos ni el aviso de que no hubiera ninguna.
  */
  const [anchoCuadricula, setAnchoCuadricula] = useState(0);
  const lado = gridItemSize(anchoCuadricula);

  if (error) {
    return (
      <View style={styles.center}>
        <Text variant="secondary" color={colors.textMuted} style={styles.centerText}>
          {error}
        </Text>
      </View>
    );
  }

  /*
    MIENTRAS CARGA, LA CUADRICULA YA ESTA AHI.

    Antes esta rama devolvia un indicador de carga suelto y nada mas. Eso
    costaba dos cosas: la persona veia un vacio donde iba a haber fotos, y el
    contenedor de la cuadricula ni siquiera existia, asi que al llegar los datos
    habia que MEDIRLO primero y solo en el fotograma siguiente aparecia algo.
    Dibujando ya los huecos, el ancho esta medido cuando llegan las
    publicaciones y las fotos entran en su sitio sin un salto de por medio.
  */
  const esperando = loading;
  const items = esperando ? [] : gallery;

  return (
    <View style={styles.wrap}>
      {/*
        Solo "Publicaciones". Los audios publicados siguen llegando en `audios`
        y se muestran en el podcast del perfil, no como una pestaña aparte.
      */}
      <SegmentedControl
        options={[esperando ? 'Publicaciones' : `Publicaciones ${gallery.length}`]}
        selectedIndex={0}
        onChange={() => {}}
        style={styles.tabs}
      />

      {!esperando && items.length === 0 ? (
        <View style={styles.center}>
          <Feather name="camera" size={30} color={colors.textMuted} />
          <Text variant="secondary" color={colors.textMuted} style={styles.centerText}>
            {emptyHint ?? t('profile.noPosts')}
          </Text>
        </View>
      ) : (
        <View
          style={styles.grid}
          onLayout={(event) => setAnchoCuadricula(event.nativeEvent.layout.width)}
        >
          {/* Hasta medir no se dibuja: pintar con un tamano inventado daria un salto. */}
          {lado === 0
            ? null
            : esperando
            ? Array.from({ length: CELDAS_DE_ESPERA }, (_, i) => (
                <View
                  key={`hueco-${i}`}
                  style={[
                    styles.tile,
                    { width: lado, height: lado, backgroundColor: colors.surfaceAlt },
                  ]}
                />
              ))
            : items.map((post, indice) => {
                /*
                  Que imagen va en la celda lo decide `miniaturaDePublicacion`,
                  el mismo sitio que consulta la precarga al tocar el perfil. Si
                  cada uno eligiera por su cuenta, se calentaria un archivo y se
                  pediria otro.
                */
                const mini = miniaturaDePublicacion(post);
                /*
                  PRIMERO LO QUE SE VE.

                  La cuadricula no se recicla: se dibujan las sesenta celdas de
                  golpe, asi que las sesenta descargas arrancan a la vez y las
                  cuatro primeras filas —las unicas que hay en pantalla—
                  compiten por la conexion con cincuenta miniaturas que nadie
                  esta mirando. En una red movil eso es exactamente la
                  diferencia entre ver el perfil enseguida y verlo tarde.
                */
                const prioridad = indice < PRIMERAS_VISIBLES ? 'high' : 'low';
                return (
                  <Pressable
                    key={post.id}
                    /*
                      Fondo NEUTRO, no negro.

                      La celda estaba pintada de negro puro a la espera de su
                      foto. Con una cuadricula entera cargando, el perfil era un
                      tablero de agujeros negros —y en tema claro, ademas,
                      chillon—. Un gris de superficie se lee como «aqui viene
                      algo», que es la verdad.
                    */
                    style={[
                      styles.tile,
                      { width: lado, height: lado, backgroundColor: colors.surfaceAlt },
                    ]}
                    onPress={() => router.push(`/post/${post.id}` as never)}
                    accessibilityRole="button"
                    accessibilityLabel={`Abrir publicación: ${post.body}`}
                  >
                    {/*
                      `pointerEvents="none"` deja pasar el toque a esta celda: sin
                      ello los controles del video se lo quedaban y no se abria la
                      publicacion (y en web anidaba elementos interactivos).
                    */}
                    <View style={StyleSheet.absoluteFill} pointerEvents="none">
                      {post.mediaType === 'video' ? (
                        /*
                          Sin reproductor: en una cuadricula no se reproduce
                          nada. `uri` solo lo usa la variante del navegador, y
                          solo cuando NO hay poster, para sacar el primer
                          fotograma; en el movil se ignora.
                        */
                        <VideoTile
                          uri={post.mediaUrl}
                          posterUrl={mini?.uri}
                          posterCacheKey={mini?.cacheKey}
                          fondo={colors.surfaceAlt}
                          colorSimbolo={colors.textMuted}
                          prioridad={prioridad}
                        />
                      ) : mini || post.imageKey ? (
                        <ExpoImage
                          source={
                            mini
                              ? { uri: mini.uri, cacheKey: mini.cacheKey }
                              : assets[post.imageKey!]
                          }
                          style={StyleSheet.absoluteFill}
                          contentFit="cover"
                          /*
                            En disco, como el resto de fotos de publicacion. Un
                            perfil trae hasta sesenta miniaturas; guardarlas
                            todas descomprimidas en memoria es lo que hacia que
                            Android empezara a soltar imagenes ya pintadas y
                            algunas celdas volvieran a quedarse vacias.
                          */
                          cachePolicy="disk"
                          // La cuadricula reaprovecha las mismas casillas al
                          // desplazarse; sin esta marca la miniatura anterior sigue
                          // ocupando memoria hasta que le toca soltarse. Va la RUTA,
                          // no la firma: la firma cambia en cada refirma.
                          recyclingKey={mini?.cacheKey ?? mini?.uri ?? post.imageKey}
                          priority={prioridad}
                          transition={120}
                        />
                      ) : (
                        // Sin URL (p. ej. sesion caducada al firmar): un marcador
                        // neutro. Poner aqui una imagen del demo mostraria contenido
                        // que no es de esta persona.
                        <View style={styles.placeholder}>
                          <Feather name="image" size={20} color={colors.textMuted} />
                        </View>
                      )}
                    </View>

                    {post.mediaType === 'video' ? (
                      <View style={styles.badge} pointerEvents="none">
                        <Feather name="play" size={11} color="#FFFFFF" />
                      </View>
                    ) : null}
                  </Pressable>
                );
              })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.sm },
  tabs: { marginBottom: spacing.md },
  center: { alignItems: 'center', justifyContent: 'center', gap: spacing.sm, paddingVertical: spacing.xxl },
  centerText: { textAlign: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GRID_GAP },
  // El tamano y el color llegan calculados; aqui solo lo que no depende de ellos.
  tile: { overflow: 'hidden' },
  badge: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholder: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
});
