import React, { useEffect, useLayoutEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';

import { CabeceraDeAdjunto } from '@/components/chat/CabeceraDeAdjunto';
import { useTranslation } from '@/i18n/useTranslation';
import { partesDeDuracion } from '@/lib/nombresDeAdjuntos';
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
  /** Mantener presionado (en Contenido, elegir para agregar a un tema). */
  alMantener?: () => void;
};

/**
 * Lo que la carátula necesita saber del audio para decirse: su nombre, si lo
 * tiene, y si es una nota de voz o un archivo de audio.
 */
type Identidad = { titulo: string | null; notaDeVoz: boolean };

/** Ancho fijo de la onda. Con anchos variables las burbujas bailan al cargar. */
const BARRAS = [0.35, 0.6, 0.85, 0.5, 0.95, 0.7, 0.4, 0.8, 0.55, 0.9, 0.45, 0.65, 0.3];

export function BurbujaDeNotaDeVoz({
  adjunto,
  mio,
  activo,
  alPulsar,
  alTerminar,
  alMantener,
}: Props) {
  const { colors } = useAppTheme();
  const color = mio ? colors.sobreBurbujaPropia : colors.text;
  const identidad: Identidad = {
    titulo: adjunto.title?.trim() || null,
    notaDeVoz: adjunto.voiceNote !== false,
  };

  /*
    CON NOMBRE, LA TARJETA: el cuadrito y el nombre arriba, y debajo el
    reproductor de siempre (lienzo «Elegida · Tarjeta»). Sin nombre se
    devuelve el reproductor solo, exactamente como antes. La cabecera es
    HERMANA del play, no lo envuelve.
  */
  const enTarjeta = (reproductor: React.ReactElement) =>
    identidad.titulo ? (
      <View style={styles.tarjeta}>
        <CabeceraDeAdjunto adjunto={adjunto} mio={mio} />
        {reproductor}
      </View>
    ) : (
      reproductor
    );

  if (activo && adjunto.url) {
    return enTarjeta(
      <NotaSonando
        uri={adjunto.url}
        duracion={adjunto.durationS ?? 0}
        color={color}
        identidad={identidad}
        cederElTurno={alTerminar}
        alMantener={alMantener}
      />,
    );
  }

  return enTarjeta(
    <Caratula
      color={color}
      duracion={adjunto.durationS ?? 0}
      avance={0}
      sonando={false}
      identidad={identidad}
      // Sin URL firmada todavía no hay nada que reproducir. El botón se pinta
      // igual pero no hace nada: pulsarlo y que no suene nada sería peor.
      alPulsar={adjunto.url ? alPulsar : undefined}
      alMantener={alMantener}
    />,
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
  identidad,
  cederElTurno,
  alMantener,
}: {
  uri: string;
  duracion: number;
  color: string;
  identidad: Identidad;
  /** Deja de ser la nota activa. Al llamarlo, la pantalla desmonta esto. */
  cederElTurno: () => void;
  alMantener?: () => void;
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
      identidad={identidad}
      // Pulsar mientras suena cede el turno, o sea: para. Es lo mismo que
      // terminar, y por eso comparten camino.
      alPulsar={cederElTurno}
      alMantener={alMantener}
    />
  );
}

/** Lo que se ve. No sabe de audio: recibe números ya calculados. */
function Caratula({
  color,
  duracion,
  avance,
  sonando,
  identidad,
  alPulsar,
  alMantener,
}: {
  color: string;
  duracion: number;
  avance: number;
  sonando: boolean;
  identidad: Identidad;
  alPulsar?: () => void;
  alMantener?: () => void;
}) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  /*
    Un archivo de audio puede llegar sin duración (no la exige el servidor):
    entonces no se pinta un «0:00» que mentiría. Una nota de voz la trae
    siempre, y se pinta como antes.
  */
  const conReloj = identidad.notaDeVoz || duracion > 0;
  return (
    <Pressable
      onPress={alPulsar}
      onLongPress={alMantener}
      delayLongPress={400}
      disabled={!alPulsar && !alMantener}
      accessibilityRole="button"
      accessibilityLabel={etiquetaDelPlay(t, { sonando, duracion, identidad })}
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

      {conReloj ? (
        <Text style={[styles.reloj, { color, opacity: 0.85 }]}>
          {formatearDuracion(duracion)}
        </Text>
      ) : null}

      {/* Marca si es una nota de voz o un archivo de audio. */}
      <Feather
        name={identidad.notaDeVoz ? 'mic' : 'music'}
        size={11}
        color={colors.textMuted}
        style={{ opacity: 0.6 }}
      />
    </Pressable>
  );
}

type Traducir = ReturnType<typeof useTranslation>['t'];

/**
 * Lo que dice el lector de pantalla del play.
 *
 * Sin nombre, una nota de voz se anuncia como siempre. Con nombre se dice el
 * nombre y la duración en palabras («Reproducir Meditación de la mañana, 42
 * segundos»): «0:42» leído en voz alta no se entiende.
 */
function etiquetaDelPlay(
  t: Traducir,
  { sonando, duracion, identidad }: { sonando: boolean; duracion: number; identidad: Identidad },
): string {
  const { titulo, notaDeVoz } = identidad;
  if (sonando) return titulo ? t('chat.stopNamed', { nombre: titulo }) : 'Parar la nota de voz';
  const partes = partesDeDuracion(duracion);
  if (titulo) {
    return partes
      ? t('chat.playNamed', { nombre: titulo, duracion: duracionHablada(t, partes) })
      : t('chat.playNamedNoDuration', { nombre: titulo });
  }
  if (!notaDeVoz) {
    return partes
      ? t('chat.playAudioFile', { duracion: duracionHablada(t, partes) })
      : t('chat.playAudioFileNoDuration');
  }
  return `Reproducir nota de voz de ${formatearDuracion(duracion)}`;
}

/** «42 segundos», «1 segundo», «1 min 15 s». */
function duracionHablada(t: Traducir, { minutos, segundos }: { minutos: number; segundos: number }): string {
  if (minutos === 0) {
    return segundos === 1 ? t('chat.spokenOneSecond') : t('chat.spokenSeconds', { n: segundos });
  }
  return t('chat.spokenMinutes', { m: minutos, s: segundos });
}

const styles = StyleSheet.create({
  tarjeta: { gap: spacing.sm },
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
