import React from 'react';
import { StyleSheet, View } from 'react-native';

import { palette } from '@/theme/tokens';

const media = palette('dark');

/**
 * Celda de video dentro de una cuadricula (navegador).
 *
 * En el movil esta misma celda no monta reproductor: cada uno reserva memoria
 * y una cuadricula con varios videos agotaba la que Android concede a la
 * aplicacion, que la cerraba de golpe.
 *
 * En el navegador ese problema no existe —la memoria la administra el propio
 * navegador y descarta lo que no se usa—, asi que aqui si se puede pedir el
 * primer fotograma y ensenar de que va el video, que es lo que ya se veia y no
 * hay motivo para perder.
 *
 * `preload="metadata"` mas el fragmento `#t=0.001` traen solo el principio del
 * archivo y pintan ese instante: no se descarga el video entero.
 */
export function VideoTile({
  uri,
  posterUrl,
}: {
  uri?: string | null;
  posterUrl?: string | null;
  /** Solo lo usa la variante nativa; aqui la cache la lleva el navegador. */
  posterCacheKey?: string | null;
}) {
  const src = uri && !uri.includes('#') ? `${uri}#t=0.001` : uri;

  return (
    <View style={[styles.wrap, { backgroundColor: media.surfaceAlt }]}>
      {src ? (
        <video
          src={src}
          poster={posterUrl ?? undefined}
          // Con poster guardado no hace falta tocar el video para la miniatura.
          preload={posterUrl ? 'none' : 'metadata'}
          muted
          playsInline
          // Es una miniatura, no un reproductor: sin controles y sin opciones
          // de descarga.
          controls={false}
          disablePictureInPicture
          disableRemotePlayback
          onContextMenu={(event) => event.preventDefault()}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            pointerEvents: 'none',
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { ...StyleSheet.absoluteFillObject },
});
