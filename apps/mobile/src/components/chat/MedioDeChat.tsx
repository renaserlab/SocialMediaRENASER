import React, { useEffect, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { Image as ExpoImage, type ImageSource } from 'expo-image';

import { Text } from '@/components/Text';
import { duracionDeVideo, rutaDePortada } from '@/lib/mediosDeChat';
import {
  copiaDe,
  descartarCopia,
  descartarPortada,
  generarPortada,
  portadaGuardada,
} from '@/services/copiasDeChat';
import { useAppTheme } from '@/theme/useAppTheme';
import type { MessageAttachment } from '@/types';

type Props = {
  adjunto: MessageAttachment;
  /** El tamaño lo pone quien lo usa: una burbuja, una tesela de «Media». */
  style?: StyleProp<ViewStyle>;
  /** En una tesela pequeña el triángulo y la duración van más chicos. */
  compacto?: boolean;
  /** Lo que va encima de la imagen: la hora, de quién es. */
  children?: React.ReactNode;
};

/**
 * De dónde sale lo que se pinta de una foto o de un video del chat.
 *
 * EL ORDEN ES LO QUE HACE QUE CARGUE RÁPIDO:
 *
 *  1. Lo que este teléfono ya tiene: la foto que se acaba de mandar, o la
 *     portada que se sacó antes. Cero red.
 *  2. La del servidor, guardada en el disco con LA RUTA como clave, no con la
 *     dirección. La dirección firmada cambia cada hora y en cada arranque: con
 *     ella de clave, la misma foto se volvía a bajar entera cada vez que se
 *     abría el chat. Con la ruta, se baja una vez.
 *  3. Solo para un video sin portada: sacarla del propio video.
 */
function useFuente(adjunto: MessageAttachment): {
  fuente: ImageSource | null;
  alFallar: () => void;
} {
  const esVideo = adjunto.kind === 'video';
  const ruta = adjunto.storagePath;
  // Mientras se envía no hay ruta: la clave es la burbuja provisional.
  const clave = ruta || adjunto.id;
  // Solo para volver a pintar cuando cambia algo que vive fuera de React.
  const [, repintar] = useState(0);
  const [sinPortadaDelServidor, setSinPortadaDelServidor] = useState<string | null>(null);

  const local = esVideo ? portadaGuardada(clave) : copiaDe(ruta);
  const remota = esVideo
    ? adjunto.posterUrl && sinPortadaDelServidor !== clave
      ? { uri: adjunto.posterUrl, cacheKey: rutaDePortada(ruta) }
      : null
    : adjunto.url
      ? adjunto.url.startsWith('http')
        ? { uri: adjunto.url, cacheKey: ruta }
        : { uri: adjunto.url }
      : null;

  const hayQueSacarla = esVideo && !local && !remota && !!adjunto.url;
  const origen = adjunto.url;
  useEffect(() => {
    if (!hayQueSacarla || !origen) return;
    let vivo = true;
    void generarPortada(clave, origen).then((uri) => {
      if (vivo && uri) repintar((n) => n + 1);
    });
    return () => {
      vivo = false;
    };
  }, [hayQueSacarla, clave, origen]);

  return {
    fuente: local ? { uri: local } : remota,
    alFallar: () => {
      if (local) {
        // La copia ya no está (el sistema limpia la carpeta temporal): se
        // pasa a la del servidor.
        if (esVideo) descartarPortada(clave);
        else descartarCopia(ruta);
        repintar((n) => n + 1);
      } else if (esVideo && remota) {
        setSinPortadaDelServidor(clave);
      }
    },
  };
}

/**
 * Una foto o un video del chat, tal como se ve antes de abrirlo.
 *
 * Es UNA sola pieza para la burbuja y para la cuadrícula de «Media», de modo
 * que las dos compartan lo guardado: la foto que se vio en el chat ya está en
 * el disco cuando se abre «Media», y al revés.
 *
 * Un video enseña su portada con el triángulo encima y cuánto dura. Mientras
 * la portada no está —o si no se puede sacar— queda el cuadro oscuro de
 * siempre: nunca un hueco.
 */
export function MedioDeChat({ adjunto, style, compacto = false, children }: Props) {
  const { colors } = useAppTheme();
  const esVideo = adjunto.kind === 'video';
  const { fuente, alFallar } = useFuente(adjunto);
  const duracion = esVideo ? duracionDeVideo(adjunto.durationS) : '';

  return (
    <View
      style={[
        styles.caja,
        // Un video sin portada se queda oscuro, como un reproductor en pausa;
        // una foto que todavía baja, del gris del fondo.
        { backgroundColor: esVideo ? '#111' : colors.surfaceAlt },
        style,
      ]}
    >
      {fuente ? (
        <ExpoImage
          source={fuente}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          cachePolicy="disk"
          // La lista recicla celdas: sin esto, la celda enseñaría un instante
          // la foto del mensaje anterior.
          recyclingKey={adjunto.id}
          transition={120}
          onError={alFallar}
        />
      ) : null}
      {esVideo ? (
        <View style={[styles.play, compacto && styles.playCompacto]}>
          <Feather name="play" size={compacto ? 16 : 22} color="#FFF" />
        </View>
      ) : null}
      {duracion ? (
        <View style={[styles.duracion, compacto && styles.duracionCompacta]}>
          <Text color="#FFF" style={styles.duracionTexto}>
            {duracion}
          </Text>
        </View>
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  caja: { overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  play: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    // El triángulo de Feather no está centrado en su caja: se ve corrido.
    paddingLeft: 3,
  },
  playCompacto: { width: 32, height: 32, borderRadius: 16, paddingLeft: 2 },
  duracion: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  duracionCompacta: { left: 4, bottom: 4, paddingHorizontal: 4, paddingVertical: 1 },
  duracionTexto: { fontSize: 11, lineHeight: 14, fontWeight: '700' },
});
