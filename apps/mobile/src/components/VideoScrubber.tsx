import { useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';

import {
  progressRatio,
  ratioAfterDrag,
  ratioAtTouch,
  secondsAt,
  stepSeconds,
} from '@/lib/videoScrub';
import { palette } from '@/theme/tokens';

// Va siempre encima de un video, asi que el contexto es oscuro en ambos temas.
const media = palette('dark');

const TRACK_HEIGHT = 3;
const TRACK_HEIGHT_DRAGGING = 6;
const THUMB_SIZE = 14;
/** Alto de la zona sensible al dedo. El minimo comodo es 44 px. */
const HIT_HEIGHT = 44;

type Props = {
  /** Segundo por el que va el video. */
  currentTime: number;
  /** Duracion total. Puede ser 0 mientras el video carga. */
  duration: number;
  /** Se llama al soltar, con el segundo elegido. */
  onSeek: (seconds: number) => void;
  /** Separacion respecto al borde inferior. */
  bottom?: number;
};

/**
 * Barra de progreso que se puede arrastrar con el dedo, al estilo de los
 * videos verticales de las redes sociales.
 *
 * Mientras se arrastra manda la posicion del dedo, no la del reproductor: si
 * se pintara lo que informa el video, la barra pelearia con el dedo y daria
 * tirones, porque el reproductor sigue avanzando durante el gesto.
 *
 * La busqueda se hace al SOLTAR, no en cada movimiento. Saltar de posicion
 * obliga al reproductor a rellenar el buffer otra vez; hacerlo decenas de
 * veces por segundo entrecorta el video y calienta el telefono.
 */
export function VideoScrubber({ currentTime, duration, onSeek, bottom = 0 }: Props) {
  const [width, setWidth] = useState(0);
  const [dragRatio, setDragRatio] = useState<number | null>(null);

  /*
    El gesto se crea una sola vez, asi que si leyera las variables del render
    se quedaria con las del primero: el ancho todavia sin medir y una duracion
    de cero. Por eso los valores vivos van por referencia.
  */
  const live = useRef({ width: 0, duration: 0, start: 0, onSeek });
  live.current.width = width;
  live.current.duration = duration;
  live.current.onSeek = onSeek;

  const responder = useMemo(
    () =>
      PanResponder.create({
        // Se reclama el gesto desde el primer contacto para que el toque no lo
        // recoja la capa de pausa que hay debajo ni la lista vertical: tocar
        // la barra tiene que buscar en el video, no pausarlo ni pasar al
        // siguiente.
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponderCapture: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (event) => {
          const ratio = ratioAtTouch(event.nativeEvent.locationX, live.current.width);
          live.current.start = ratio;
          setDragRatio(ratio);
        },
        onPanResponderMove: (_event, gesture) => {
          setDragRatio(ratioAfterDrag(live.current.start, gesture.dx, live.current.width));
        },
        onPanResponderRelease: (_event, gesture) => {
          const ratio = ratioAfterDrag(live.current.start, gesture.dx, live.current.width);
          live.current.onSeek(secondsAt(ratio, live.current.duration));
          setDragRatio(null);
        },
        // Si el sistema corta el gesto (una llamada, por ejemplo) se vuelve a
        // seguir al reproductor en vez de quedarse congelada donde estaba.
        onPanResponderTerminate: () => setDragRatio(null),
      }),
    [],
  );

  const dragging = dragRatio !== null;
  const ratio = dragRatio ?? progressRatio(currentTime, duration);
  const percent = `${ratio * 100}%` as const;

  const step = stepSeconds(duration);

  return (
    <View
      {...responder.panHandlers}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={[styles.hit, { bottom }]}
      // `adjustable` es lo que anuncia a los lectores de pantalla que esto se
      // puede recorrer; sin acciones, quien no puede arrastrar se queda fuera.
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Progreso del video"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(ratio * 100) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) => {
        if (duration <= 0) return;
        const delta = event.nativeEvent.actionName === 'increment' ? step : -step;
        onSeek(Math.min(duration, Math.max(0, currentTime + delta)));
      }}
    >
      {/*
        Todo lo de dentro es decorativo y no debe capturar el toque: si lo
        hiciera, la coordenada del dedo vendria medida respecto al trocito
        pulsado y no respecto a la barra entera.
      */}
      <View style={styles.trackArea} pointerEvents="none">
        {/*
          El carril va en blanco translucido, no en negro: sobre un video
          oscuro un carril negro no se ve, y entonces no hay forma de saber
          que la barra se puede arrastrar hasta que ya se ha reproducido algo.

          Va como hermano de la parte rellena y no como su contenedor porque
          `opacity` tine tambien a los hijos, y lo ya reproducido tiene que
          quedar solido.
        */}
        <View
          style={[
            styles.track,
            { height: dragging ? TRACK_HEIGHT_DRAGGING : TRACK_HEIGHT, backgroundColor: media.text },
          ]}
        />
        <View
          style={[
            styles.fill,
            {
              width: percent,
              height: dragging ? TRACK_HEIGHT_DRAGGING : TRACK_HEIGHT,
              backgroundColor: media.text,
            },
          ]}
        />
        {/*
          El circulo solo aparece durante el arrastre. En reposo estorba sobre
          el video; mientras se arrastra es la referencia de donde se va a
          soltar.
        */}
        {dragging ? (
          <View style={[styles.thumb, { left: percent, backgroundColor: media.text }]} />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hit: { position: 'absolute', left: 0, right: 0, height: HIT_HEIGHT, justifyContent: 'flex-end', zIndex: 15 },
  trackArea: { justifyContent: 'flex-end', paddingBottom: 10 },
  // Translucido para que se siga viendo el video por debajo del carril.
  track: { width: '100%', opacity: 0.35 },
  fill: { position: 'absolute', left: 0, bottom: 10 },
  thumb: {
    position: 'absolute',
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    // Centra el circulo en la posicion en vez de dejarlo colgando a su derecha.
    marginLeft: -THUMB_SIZE / 2,
    bottom: 10 - THUMB_SIZE / 2 + TRACK_HEIGHT_DRAGGING / 2,
  },
});
