import React, { useEffect, useLayoutEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';

import { formatearDuracion } from '@/lib/notaDeVoz';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { MessageAttachment } from '@/types';

/**
 * Una nota de voz dentro de una burbuja del chat.
 *
 * LA REGLA QUE MANDA AQUI, Y NO ES NEGOCIABLE: EN TODA LA CONVERSACION HAY COMO
 * MUCHO **UN** REPRODUCTOR MONTADO.
 *
 * Este proyecto ya pagó esto dos veces, y las dos están escritas en
 * `components/cuadriculaSinReproductores.test.mts`: un reproductor por celda en
 * la cuadrícula del perfil, y otro por vídeo en cada reseña recibida. Cada
 * reproductor nativo reserva memoria por delante aunque no esté reproduciendo,
 * así que unos pocos agotaban la que Android concede y cerraban la aplicación.
 * Un chat es todavía peor que una cuadrícula: el historial pagina, así que la
 * lista crece sin techo mientras alguien sube por la conversación. Treinta notas
 * de voz cargadas serían treinta reproductores.
 *
 * COMO SE CONSIGUE. Este componente NO crea ningún reproductor. Pinta una
 * carátula —el botón de play, la onda y la duración, que es todo lo que hace
 * falta para leer la lista— y solo cuando alguien la pulsa, la pantalla marca
 * ESA nota como la activa y entonces se monta `<NotaSonando />`, que es el único
 * que toca `expo-audio`. Al pulsar otra, la anterior se desmonta.
 *
 * Es exactamente el patrón `videoAbierto ===` de `ProfileSection`, y el
 * `active || preload` de `ShortVideoItem`: la guarda está FUERA del componente
 * que reproduce, porque un componente no puede decidir no montarse a sí mismo.
 *
 * Y POR ESO LA DURACION VIENE DEL SERVIDOR (`durationS`) Y NO DEL REPRODUCTOR.
 * Preguntársela al audio exigiría abrirlo, que es justo lo que no se hace. El
 * backend la guarda al recibir la nota (`message_attachments.duration_s`), y por
 * eso la exige: sin ella, la lista no se podría pintar sin descargarlo todo.
 */

type Props = {
  adjunto: MessageAttachment;
  /** La burbuja es propia: cambia el color del texto sobre el fondo. */
  mio: boolean;
  /** Si ESTA es la nota que está sonando. Solo entonces hay reproductor. */
  activo: boolean;
  /** Pedir el turno: la pantalla desmonta la anterior y monta esta. */
  alPulsar: () => void;
  /** Terminó, o se paró. La pantalla libera el turno. */
  alTerminar: () => void;
};

/** Ancho fijo de la onda. Con anchos variables las burbujas bailan al cargar. */
const BARRAS = [0.35, 0.6, 0.85, 0.5, 0.95, 0.7, 0.4, 0.8, 0.55, 0.9, 0.45, 0.65, 0.3];

export function BurbujaDeNotaDeVoz({ adjunto, mio, activo, alPulsar, alTerminar }: Props) {
  const { colors } = useAppTheme();
  const color = mio ? colors.onPrimary : colors.text;

  if (activo && adjunto.url) {
    return (
      <NotaSonando
        uri={adjunto.url}
        duracion={adjunto.durationS ?? 0}
        color={color}
        cederElTurno={alTerminar}
      />
    );
  }

  return (
    <Caratula
      color={color}
      duracion={adjunto.durationS ?? 0}
      avance={0}
      sonando={false}
      // Sin URL firmada todavía no hay nada que reproducir. El botón se pinta
      // igual pero no hace nada: pulsarlo y que no suene nada sería peor.
      alPulsar={adjunto.url ? alPulsar : undefined}
    />
  );
}

/**
 * El único sitio de toda la conversación donde vive un reproductor.
 *
 * SE MONTA YA SONANDO. Quien pulsa play espera oír algo; obligar a un segundo
 * toque —uno para montar, otro para reproducir— sería el precio visible de una
 * decisión interna.
 */
function NotaSonando({
  uri,
  duracion,
  color,
  cederElTurno,
}: {
  uri: string;
  duracion: number;
  color: string;
  /** Deja de ser la nota activa. Al llamarlo, la pantalla desmonta esto. */
  cederElTurno: () => void;
}) {
  const reproductor = useAudioPlayer({ uri });
  const estado = useAudioPlayerStatus(reproductor);

  /*
    EL APAGADO VA EN LA FASE DE LAYOUT, y no es una preferencia de estilo: es la
    lección que dejó escrita `components/audioDelReproductor.test.mts`. Las
    limpiezas pasivas de React corren en orden de declaración, y `expo-audio`
    suelta el objeto nativo en la suya —declarada dentro del hook, antes que
    ninguna de este componente—. Un `pause()` en un `useEffect` normal caería
    sobre un objeto ya muerto y el audio seguiría oyéndose unos milisegundos
    encima de la pantalla siguiente.

    Se silencia ADEMAS de pausar por el hueco que queda entre la pausa y la
    liberación nativa: un buffer ya entregado puede seguir sonando.
  */
  useLayoutEffect(() => {
    return () => {
      try {
        reproductor.muted = true;
        reproductor.pause();
      } catch {
        /* Ya se liberó. Parar dos veces no es un error. */
      }
    };
  }, [reproductor]);

  useEffect(() => {
    reproductor.play();
  }, [reproductor]);

  /*
    Al acabar se cede el turno, lo que desmonta este componente.

    `didJustFinish` y no «el tiempo llegó al final»: con la comparación de
    segundos, una nota que termina a 4,97 de 5,00 no se daría nunca por
    terminada y el reproductor se quedaría montado para siempre — que es
    justamente el reproductor de más que todo esto evita.
  */
  useEffect(() => {
    if (estado?.didJustFinish) cederElTurno();
  }, [estado?.didJustFinish, cederElTurno]);

  const total = estado?.duration || duracion;
  const actual = estado?.currentTime ?? 0;

  return (
    <Caratula
      color={color}
      duracion={total > 0 ? Math.max(0, total - actual) : duracion}
      avance={total > 0 ? Math.min(1, actual / total) : 0}
      sonando={estado?.playing ?? true}
      // Pulsar mientras suena cede el turno, o sea: para. Es lo mismo que
      // terminar, y por eso comparten camino.
      alPulsar={cederElTurno}
    />
  );
}

/** Lo que se ve. No sabe de audio: recibe números ya calculados. */
function Caratula({
  color,
  duracion,
  avance,
  sonando,
  alPulsar,
}: {
  color: string;
  duracion: number;
  avance: number;
  sonando: boolean;
  alPulsar?: () => void;
}) {
  const { colors } = useAppTheme();
  return (
    <Pressable
      onPress={alPulsar}
      disabled={!alPulsar}
      accessibilityRole="button"
      accessibilityLabel={
        sonando
          ? 'Parar la nota de voz'
          : `Reproducir nota de voz de ${formatearDuracion(duracion)}`
      }
      style={styles.fila}
      hitSlop={6}
    >
      <View style={[styles.boton, { borderColor: color }]}>
        <Feather name={sonando ? 'pause' : 'play'} size={14} color={color} />
      </View>

      {/*
        La onda es DECORATIVA y a propósito. Dibujar la forma real del audio
        exigiría descargarlo y analizarlo entero solo para pintar una fila, que
        es el coste que toda esta pantalla evita. Lo que sí es real es el
        progreso: las barras ya oídas van opacas y el resto translúcidas.
      */}
      <View style={styles.onda} pointerEvents="none">
        {BARRAS.map((alto, i) => (
          <View
            key={i}
            style={[
              styles.barra,
              {
                height: 4 + alto * 16,
                backgroundColor: color,
                opacity: i / BARRAS.length <= avance ? 0.95 : 0.35,
              },
            ]}
          />
        ))}
      </View>

      <Text style={[styles.reloj, { color, opacity: 0.85 }]}>
        {formatearDuracion(duracion)}
      </Text>

      {/* Marca que esto es una nota de voz y no un archivo cualquiera. */}
      <Feather name="mic" size={11} color={colors.textMuted} style={{ opacity: 0.6 }} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minWidth: 190,
    paddingVertical: 2,
  },
  boton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  onda: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 2, height: 22 },
  barra: { width: 2.5, borderRadius: radius.pill },
  reloj: { fontSize: 11, fontVariant: ['tabular-nums'], minWidth: 30 },
});
