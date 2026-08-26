import React, { useMemo, useRef, useState } from 'react';
import { LayoutChangeEvent, PanResponder, StyleSheet, View } from 'react-native';

import { SinCambioDeSeccion } from '@/navigation/tabSwipe';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

type Props = {
  /** Segundo en el que va el audio. */
  currentTime: number;
  /** Duración total; con 0 la barra queda inerte (aún no se conoce el audio). */
  duration: number;
  /** Se llama al soltar, con el segundo elegido. */
  onSeek: (seconds: number) => void;
  /**
   * Avisa del segundo que marca el dedo mientras se arrastra, y de `null` al
   * soltar. Sirve para que el reloj de al lado muestre a dónde se va a saltar.
   */
  onScrubChange?: (seconds: number | null) => void;
  /** Grosor de la barra. */
  height?: number;
  /** Color del borde del círculo; conviene el fondo sobre el que se dibuja. */
  knobBorderColor?: string;
};

/**
 * Barra de progreso que se puede arrastrar con el dedo para adelantar o
 * retrasar el audio.
 *
 * Dos decisiones que hacen que el gesto se sienta bien:
 *
 *  - Mientras se arrastra manda la posición del dedo, no la del reproductor.
 *    Si se pintara la del reproductor, la barra retrocedería en cada
 *    actualización de estado hasta que el motor terminara de buscar y el
 *    arrastre se sentiría elástico.
 *  - El salto se pide UNA vez, al soltar. Pedirlo en cada movimiento encadena
 *    decenas de búsquedas por segundo y entrecorta el sonido.
 */
export function AudioScrubber({
  currentTime,
  duration,
  onSeek,
  onScrubChange,
  height = 4,
  knobBorderColor,
}: Props) {
  const { colors } = useAppTheme();
  const [trackWidth, setTrackWidth] = useState(0);
  const [scrubRatio, setScrubRatio] = useState<number | null>(null);

  // PanResponder crea sus callbacks una sola vez, así que no puede leer las
  // variables del render: se le quedarían congeladas las del primero. Estas
  // referencias son la vía para darle siempre los valores actuales.
  const live = useRef({ width: 0, duration: 0, onSeek, onScrubChange });
  live.current = { width: trackWidth, duration, onSeek, onScrubChange };
  // Punto donde empezó el gesto y última posición calculada.
  const gesture = useRef({ startRatio: 0, ratio: 0 });

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        // Con `onStart...` un toque simple también salta a esa posición.
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        // Impide que el scroll de la pantalla se lleve el gesto a media barra.
        onPanResponderTerminationRequest: () => false,

        onPanResponderGrant: (evt) => {
          const { width, duration: total, onScrubChange: report } = live.current;
          if (width <= 0) return;
          const ratio = clamp(evt.nativeEvent.locationX / width);
          gesture.current = { startRatio: ratio, ratio };
          setScrubRatio(ratio);
          report?.(ratio * total);
        },
        onPanResponderMove: (_evt, state) => {
          const { width, duration: total, onScrubChange: report } = live.current;
          if (width <= 0) return;
          // Se parte del punto inicial y se suma el desplazamiento acumulado:
          // `locationX` deja de ser fiable en cuanto el dedo sale de la barra,
          // y aquí interesa poder arrastrar de lado a lado sin soltar.
          const ratio = clamp(gesture.current.startRatio + state.dx / width);
          gesture.current.ratio = ratio;
          setScrubRatio(ratio);
          report?.(ratio * total);
        },
        onPanResponderRelease: () => {
          const { duration: total, onSeek: seek, onScrubChange: report } = live.current;
          if (total > 0) seek(gesture.current.ratio * total);
          setScrubRatio(null);
          report?.(null);
        },
        onPanResponderTerminate: () => {
          setScrubRatio(null);
          live.current.onScrubChange?.(null);
        },
      }),
    [],
  );

  const ratio = scrubRatio ?? (duration > 0 ? clamp(currentTime / duration) : 0);
  const dragging = scrubRatio != null;

  return (
    /*
      Arrastrar esta barra es buscar dentro del audio, no cambiar de seccion.

      Las tres pantallas donde aparece —el reproductor del muro, el de la lista
      de podcast y `(tabs)/audio/[id]`— viven DENTRO de las pestanas, asi que el
      carrusel de secciones escucha el arrastre horizontal desde arriba y, al
      activarse, cancela este `PanResponder`. Sin blindar, mover el dedo sobre
      la barra saltaba de seccion en vez de adelantar el audio. Es exactamente
      lo mismo que ya hacia la barra del video (`VideoScrubber`), y a esta se le
      habia pasado.

      `activarAlTocar` reserva el gesto desde el primer contacto: esto no es un
      ScrollView que "empiece a moverse", asi que no hay otra senal a la que
      esperar.
    */
    <SinCambioDeSeccion activarAlTocar>
    <View
      // La zona que responde al dedo es más alta que la barra visible, para
      // poder cogerla sin apuntar con precisión.
      style={styles.touch}
      onLayout={(e: LayoutChangeEvent) => setTrackWidth(e.nativeEvent.layout.width)}
      accessibilityRole="adjustable"
      accessibilityLabel="Posición del audio"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(ratio * 100) }}
      {...panResponder.panHandlers}
    >
      <View style={[styles.track, { height, backgroundColor: colors.border }]}>
        <View
          style={[styles.fill, { width: `${ratio * 100}%`, backgroundColor: colors.primary }]}
        />
      </View>
      <View
        style={[
          styles.knob,
          {
            left: `${ratio * 100}%`,
            backgroundColor: colors.primary,
            borderColor: knobBorderColor ?? colors.background,
            transform: [{ scale: dragging ? 1.3 : 1 }],
          },
        ]}
      />
    </View>
    </SinCambioDeSeccion>
  );
}

const styles = StyleSheet.create({
  touch: { width: '100%', height: spacing.xl, justifyContent: 'center' },
  track: { width: '100%', borderRadius: radius.pill, overflow: 'hidden' },
  fill: { height: '100%' },
  knob: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    // Centra el círculo sobre la posición exacta en vez de dejarlo a su derecha.
    marginLeft: -7,
  },
});
