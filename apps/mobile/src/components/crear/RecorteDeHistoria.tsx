import React, { useCallback, useMemo, useRef, useState } from 'react';
import { LayoutChangeEvent, PanResponder, Pressable, StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { Button } from '@/components/Button';
import { ScrimDeMedio, SuperficieSobreMedio, sobreMedio } from '@/components/CapaDeContraste';
import { useEspacioInferior } from '@/components/espacioInferior';
import { Text } from '@/components/Text';
import { VideoPlayer } from '@/components/VideoPlayer';
import {
  MAX_HISTORIA_MS,
  desplazarTramo,
  largoDelTramo,
  moverFin,
  moverInicio,
  reloj,
  tramoInicial,
  type Tramo,
} from '@/lib/historias';
import { SinCambioDeSeccion } from '@/navigation/tabSwipe';
import { radius, spacing } from '@/theme/tokens';
import { useTranslation } from '@/i18n/useTranslation';

// Va siempre sobre un video a pantalla completa: el contexto es oscuro en los
// dos temas, igual que en `ModoHistoria`.
const media = sobreMedio;

/** Ancho del tirador. Se usa tambien para dejarle sitio dentro de la barra. */
const TIRADOR = 20;
/** Alto de la barra de recorte. Comodo de coger sin apuntar. */
const ALTO = 56;

type Props = {
  /** El video que se esta recortando (fichero local, aun sin subir). */
  uri: string;
  /** Lo que dura, medido. Siempre mayor que el tope o esto no se abriria. */
  duracionMs: number;
  /** Por que ha aparecido esta pantalla, dicho con las cifras concretas. */
  aviso: string;
  /** Confirmar el tramo elegido. */
  alElegir: (tramo: Tramo) => void;
  /** Volver a elegir otro video. */
  alVolver: () => void;
};

/**
 * Elegir QUE TRAMO de un video largo se publica como historia.
 *
 * ===========================================================================
 * AQUI NO SE RECORTA NADA. Esta pantalla solo elige el tramo; el corte lo hace
 * el SERVIDOR despues de subir el video ENTERO.
 * ===========================================================================
 *
 * No es lo que hace WhatsApp, que corta antes de subir. En este proyecto no se
 * puede: `react-native-compressor` —el unico modulo nativo de media que hay—
 * solo recomprime archivos completos, y no hay `expo-av`, ni
 * `expo-video-thumbnails`, ni `ffmpeg-kit`. Cortar aqui exigiria una
 * dependencia nativa nueva y una compilacion nueva. Donde SI hay ffmpeg es en
 * el servidor, desde el 27/08/2026. Asi que el orden es:
 *
 *     subir el video entero -> el servidor recorta -> el servidor publica
 *
 * Y ese coste —los datos de quien publica— NO SE ESCONDE: se dice en la propia
 * pantalla, encima del boton (`story.trimWholeUploadNotice`). Quien sube un
 * video de cinco minutos para publicar treinta segundos tiene derecho a saber
 * que se suben los cinco minutos.
 *
 * Las cuentas del tramo viven en `lib/historias` y se prueban solas. Aqui solo
 * hay pixeles, dedos y la traduccion de uno a otro.
 */
export function RecorteDeHistoria({ uri, duracionMs, aviso, alElegir, alVolver }: Props) {
  const { t } = useTranslation();
  const espacioInferior = useEspacioInferior();
  const [ancho, setAncho] = useState(0);
  const [tramo, setTramo] = useState<Tramo>(() => tramoInicial(duracionMs));

  /*
    Desde donde arranca la previsualizacion. Se cambia AL SOLTAR, nunca durante
    el arrastre: `startAtSeconds` solo se aplica al montar el reproductor, asi
    que moverlo obliga a remontarlo, y remontar un video en cada movimiento del
    dedo daria un parpadeo continuo. Al soltar es una vez y se agradece: la
    persona ve empezar el tramo que acaba de elegir.
  */
  const [desdeMs, setDesdeMs] = useState(0);

  /*
    Los `PanResponder` se crean una sola vez, asi que no pueden leer las
    variables del render: se quedarian con las del primero (ancho cero, tramo
    inicial). Los valores vivos van por referencia.
  */
  const vivo = useRef({ ancho: 0, tramo, duracionMs });
  vivo.current = { ancho, tramo, duracionMs };
  /** El tramo con el que empezo el gesto en curso. */
  const alEmpezar = useRef<Tramo>(tramo);

  /** Pixeles -> milisegundos. Con la barra sin medir, nada se mueve. */
  const enMs = useCallback((px: number) => {
    const { ancho: w, duracionMs: total } = vivo.current;
    return w > 0 ? (px / w) * total : 0;
  }, []);

  const gesto = useCallback(
    (calcular: (desde: Tramo, deltaMs: number) => Tramo) =>
      PanResponder.create({
        // Se reclama desde el primer contacto: debajo hay un video que se
        // pausa al tocarlo, y coger un tirador no es tocar el video.
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          alEmpezar.current = vivo.current.tramo;
        },
        onPanResponderMove: (_evento, estado) => {
          setTramo(calcular(alEmpezar.current, enMs(estado.dx)));
        },
        onPanResponderRelease: () => {
          setDesdeMs(vivo.current.tramo.inicioMs);
        },
        onPanResponderTerminate: () => {
          setDesdeMs(vivo.current.tramo.inicioMs);
        },
      }),
    [enMs],
  );

  // Uno por tirador y otro para el tramo entero. Cada uno parte del tramo que
  // habia al tocar y le suma el desplazamiento acumulado del dedo; usar la
  // posicion absoluta del toque haria saltar el tramo al agarrarlo.
  const principio = useMemo(
    () => gesto((desde, delta) => moverInicio(duracionMs, desde, desde.inicioMs + delta)),
    [gesto, duracionMs],
  );
  const final = useMemo(
    () => gesto((desde, delta) => moverFin(duracionMs, desde, desde.finMs + delta)),
    [gesto, duracionMs],
  );
  const ventana = useMemo(
    () => gesto((desde, delta) => desplazarTramo(duracionMs, desde, delta)),
    [gesto, duracionMs],
  );

  const izquierda = duracionMs > 0 ? (tramo.inicioMs / duracionMs) * ancho : 0;
  const anchoVentana = duracionMs > 0 ? (largoDelTramo(tramo) / duracionMs) * ancho : 0;
  const segundos = largoDelTramo(tramo) / 1000;

  /*
    LOS TIRADORES VAN FUERA DE LA VENTANA, no encima.

    En un video de cinco minutos, treinta segundos son el 10 % de la barra: unos
    treinta y cinco pixeles. Dos tiradores de veinte dentro de eso taparian
    entero justo lo que hay que ver. Puestos por fuera, la seleccion se lee
    siempre —aunque sea una franja fina— y los tiradores se cogen igual.

    Se sujetan a los bordes para que no se salgan de la barra cuando el tramo
    esta pegado al principio o al final.
  */
  const topeDerecho = Math.max(0, ancho - TIRADOR);
  const tiradorIzquierdo = Math.min(Math.max(0, izquierda - TIRADOR), topeDerecho);
  const tiradorDerecho = Math.min(Math.max(0, izquierda + anchoVentana), topeDerecho);

  return (
    <View style={styles.raiz}>
      <VideoPlayer
        // Remontar es lo que hace que la previsualizacion salte al principio
        // del tramo; ver el comentario de `desdeMs`.
        key={desdeMs}
        uri={uri}
        startAtSeconds={desdeMs / 1000}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        nativeControls={false}
        autoPlay
        loop
      />

      <Pressable
        onPress={alVolver}
        hitSlop={12}
        style={styles.volver}
        accessibilityRole="button"
        accessibilityLabel={t('create.chooseSomethingElse')}
      >
        <Feather name="arrow-left" size={24} color={media.text} />
      </Pressable>

      {/*
        LA FRANJA DEL PIE SE APAGA. Todo lo de abajo —titulo, aviso, cifras y
        boton— va escrito sobre un fotograma que puede ser de cualquier color.
      */}
      <ScrimDeMedio alto={420} />

      <View style={[styles.pie, { bottom: espacioInferior }]}>
        <SuperficieSobreMedio>
          <Text variant="titleMedium" color={media.text}>
            {t('story.trimTitle')}
          </Text>
          {/* El aviso explica POR QUE aparece esta pantalla: si no se lee, la
              pantalla no se entiende. Va en el color de texto principal. */}
          <Text variant="caption" color={media.text}>
            {aviso}
          </Text>
        </SuperficieSobreMedio>

        {/*
          ARRASTRAR AQUI RECORTA, NO CAMBIA DE SECCION.

          Crear vive dentro de las pestañas, y ademas tiene su propio arrastre
          horizontal para cambiar de tipo de publicacion. O sea que este gesto
          compite con DOS, no con uno: sin blindarlo, mover un tirador saltaba
          de modo o de seccion en vez de mover el tramo. Es la misma regla que
          ya siguen `VideoScrubber` y `AudioScrubber`.

          `activarAlTocar` porque esto no es una lista que «empiece a moverse»:
          hay que reservar el gesto desde el primer contacto.
        */}
        <SinCambioDeSeccion activarAlTocar>
          <View
            style={styles.barra}
            onLayout={(e: LayoutChangeEvent) => setAncho(e.nativeEvent.layout.width)}
          >
            {/* Lo que queda FUERA del tramo se apaga: se ve de un vistazo que
                esa parte no se publica. */}
            <View style={[styles.fuera, { left: 0, width: Math.max(0, izquierda) }]} />
            <View
              style={[
                styles.fuera,
                { left: izquierda + anchoVentana, right: 0 },
              ]}
            />

            <View
              style={[styles.ventana, { left: izquierda, width: anchoVentana }]}
              accessibilityRole="adjustable"
              accessibilityLabel={t('story.trimWindow')}
              {...ventana.panHandlers}
            />
            <View
              style={[styles.tirador, { left: tiradorIzquierdo }]}
              accessibilityRole="adjustable"
              accessibilityLabel={t('story.trimStartHandle')}
              {...principio.panHandlers}
            >
              <Feather name="chevron-left" size={16} color={media.background} />
            </View>
            <View
              style={[styles.tirador, { left: tiradorDerecho }]}
              accessibilityRole="adjustable"
              accessibilityLabel={t('story.trimEndHandle')}
              {...final.panHandlers}
            >
              <Feather name="chevron-right" size={16} color={media.background} />
            </View>
          </View>
        </SinCambioDeSeccion>

        <SuperficieSobreMedio>
          <View style={styles.cifras}>
            <Text variant="caption" weight="600" color={media.text}>
              {t('story.trimSelection', {
                inicio: reloj(tramo.inicioMs),
                fin: reloj(tramo.finMs),
              })}
            </Text>
            <Text variant="caption" weight="700" color={media.text}>
              {t('story.trimSeconds', {
                segundos: Number.isInteger(segundos) ? segundos : segundos.toFixed(1),
              })}
            </Text>
          </View>

          {/* EL COMPROMISO, dicho a quien lo paga. */}
          <Text variant="caption" color={media.text} style={styles.nota}>
            {t('story.trimWholeUploadNotice')}
          </Text>
        </SuperficieSobreMedio>

        <Button
          label={t('story.trimConfirm')}
          variant="secondary"
          icon="scissors"
          onPress={() => alElegir(tramo)}
          disabled={largoDelTramo(tramo) <= 0 || largoDelTramo(tramo) > MAX_HISTORIA_MS}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  raiz: { flex: 1, backgroundColor: media.background },
  volver: {
    position: 'absolute',
    top: 54,
    left: spacing.lg,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    // Velo + borde: la flecha va sobre el video y sin fondo propio se pierde
    // en cuanto el fotograma es claro.
    backgroundColor: media.overlay,
    borderWidth: 1,
    borderColor: media.glassBorder,
  },
  // `bottom` lo pone el componente: depende de cuanto ocupe la barra flotante.
  pie: { position: 'absolute', left: spacing.lg, right: spacing.lg, gap: spacing.sm },
  barra: {
    height: ALTO,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: media.border,
    backgroundColor: media.overlay,
    overflow: 'hidden',
  },
  fuera: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    // El mismo velo que el resto de la aplicacion, por token y no a mano.
    backgroundColor: media.overlay,
  },
  ventana: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    borderWidth: 2,
    borderColor: media.text,
    borderRadius: radius.sm,
  },
  tirador: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: TIRADOR,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: media.text,
  },
  cifras: { flexDirection: 'row', justifyContent: 'space-between' },
  nota: { textAlign: 'center' },
});
