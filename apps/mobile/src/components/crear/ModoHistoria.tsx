import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Feather } from '@expo/vector-icons';

import { Button } from '@/components/Button';
import { ScrimDeMedio, SuperficieSobreMedio, sobreMedio } from '@/components/CapaDeContraste';
import { useEspacioInferior } from '@/components/espacioInferior';
import { ProgresoDePublicacion } from '@/components/crear/ProgresoDePublicacion';
import { PasoDeCaptura } from '@/components/crear/PasoDeCaptura';
import { RecorteDeHistoria } from '@/components/crear/RecorteDeHistoria';
import { Text } from '@/components/Text';
import { VideoPlayer } from '@/components/VideoPlayer';
import { usePublicacion, PublicacionCancelada } from '@/hooks/usePublicacion';
import {
  FOTO_MS,
  MAX_HISTORIA_MS,
  duracionMedida,
  revisarDuracionDeHistoria,
  type DecisionDeHistoria,
  type Tramo,
} from '@/lib/historias';
import { toast } from '@/lib/toast';
import { readVideoMetadata } from '@/services/mediaCompressor';
import { uploadPostMedia, type PickedMedia } from '@/services/storage';
import { useAppStore } from '@/store/useAppStore';
import { spacing } from '@/theme/tokens';
import { useTranslation } from '@/i18n/useTranslation';

const media = sobreMedio;

/*
  El tope de una historia y el tiempo de una foto viven en `lib/historias`, no
  aqui. Estaban repetidos a mano en tres pantallas y en el backend, y con cinco
  copias del mismo numero basta con cambiar cuatro para que la camara corte a un
  tiempo y el control de subida rechace a otro.
*/
export { MAX_HISTORIA_MS } from '@/lib/historias';

type Props = {
  /** Selector de modo, que viaja hasta dentro de la camara. */
  pie?: React.ReactNode;
  /** A donde ir al terminar o al cerrar. */
  alSalir: () => void;
  /** `false` mientras la pantalla no se esta viendo (ver `PasoDeCaptura`). */
  activo?: boolean;
};

/** Lo que se sabe del video elegido mientras se decide que hacer con el. */
type Revision = DecisionDeHistoria | { estado: 'midiendo' };

/**
 * Crear una historia: camara o carrete → (recorte si hace falta) → revision →
 * publicar.
 *
 * Es el UNICO flujo de historia que hay. La ruta `/stories/nueva` ya no es una
 * pantalla: redirige aqui. Con dos copias, cada arreglo del limite de duracion,
 * de los permisos o del reintento habria que hacerlo dos veces y una de las dos
 * se quedaria atras.
 *
 * EL VIDEO SE MIDE AL ELEGIRLO, no al publicar. Antes se medía dentro de
 * `publicar` y bastaba para rechazar; ahora hay que decidir ANTES si se enseña
 * el recortador, y para eso hay que saber cuanto dura antes de pintar nada. La
 * medida es una sola —la de aqui— y de ella salen las dos decisiones.
 *
 * Y OJO CON EL ORDEN DE LO QUE VIENE DESPUES: el tramo se elige aqui, pero el
 * corte lo hace el SERVIDOR con el video ya subido entero (ver
 * `RecorteDeHistoria` y `apps/api/app/modules/stories/recorte.py`). Si ese
 * recorte falla, no se publica nada: no hay ninguna rama que caiga a publicar
 * el video largo.
 */
export function ModoHistoria({ pie, alSalir, activo = true }: Props) {
  const { t } = useTranslation();
  const createStory = useAppStore((state) => state.createStory);
  /*
    El pie se apoya en la barra flotante, no en un numero.

    Estaba en `bottom: 44` y la capsula de secciones ocupa entre 78 y 104 px
    segun el aparato: el boton de publicar quedaba DEBAJO de ella siempre, y
    como la barra se pinta encima y se queda el toque, pulsarlo cambiaba de
    seccion. Ahora la medida sale del mismo sitio que la dibuja.
  */
  const espacioInferior = useEspacioInferior();
  const [elegido, setElegido] = useState<PickedMedia | null>(null);
  const [revision, setRevision] = useState<Revision | null>(null);
  const [tramo, setTramo] = useState<Tramo | null>(null);
  const envio = usePublicacion();

  const empezarDeCero = useCallback(() => {
    envio.limpiar();
    setElegido(null);
    setRevision(null);
    setTramo(null);
  }, [envio]);

  const elegir = useCallback(
    (medio: PickedMedia) => {
      setElegido(medio);
      setTramo(null);
      if (medio.kind !== 'video') {
        setRevision(null);
        return;
      }
      setRevision({ estado: 'midiendo' });
      /*
        SE MIDE EL ARCHIVO, no se cree lo que diga quien lo eligio.

        `elegido.durationMs` es lo que REPORTA el selector, y ese dato falta a
        menudo. Cuando faltaba valia cero y la comparacion `0 > tope` daba
        falso: un video de cinco minutos pasaba el control sin que nadie lo
        mirara. Se lee ademas la duracion del propio archivo y manda la mayor de
        las dos.

        Y se hace ANTES de subir: no para ahorrar la subida —el recorte la exige
        igual, ver `RecorteDeHistoria`— sino porque sin saber cuanto dura no se
        puede ni pintar el recortador.
      */
      void (async () => {
        const delArchivo = await readVideoMetadata(medio.uri).catch(() => null);
        const medida = duracionMedida(
          medio.durationMs,
          delArchivo?.durationS ? delArchivo.durationS * 1000 : null,
        );
        setRevision(revisarDuracionDeHistoria(medida, t));
      })();
    },
    [t],
  );

  const publicar = useCallback(() => {
    if (!elegido) return;

    void envio.ejecutar(async ({ avance, cancelado }) => {
      let duracion: number | null = null;
      if (elegido.kind === 'video') {
        // Sin medida no se publica: es el caso «el modulo nativo no esta y el
        // selector tampoco informa», y ahi no se puede ni comprobar el limite
        // ni ofrecer un tramo. Se dice, y se ofrece la salida que si funciona
        // (grabar con la camara de la app, que ya corta sola).
        if (!revision || revision.estado === 'midiendo') return;
        if (revision.estado === 'sin-medir') throw new Error(revision.mensaje);
        if (revision.estado === 'demasiado-larga' && !tramo) {
          // No deberia llegarse aqui —el recortador se pinta antes— pero si se
          // llega, NO se publica. Nunca hay una rama que suba el video largo.
          throw new Error(revision.mensaje);
        }
        duracion = tramo ? tramo.finMs - tramo.inicioMs : revision.durationMs;
      }

      /*
        SUBE EL VIDEO ENTERO, TAMBIEN CUANDO HAY RECORTE. Es EL compromiso de
        esta funcion y no se disimula: en el telefono no hay con que cortar
        (`react-native-compressor` solo recomprime archivos completos, y no hay
        expo-av ni ffmpeg-kit), asi que sube todo y el servidor se queda con el
        tramo. La alternativa era una dependencia nativa nueva y una compilacion
        nueva; la otra alternativa, fingir un recorte que no existe.
      */
      const subido = await uploadPostMedia(elegido, avance);
      // Se comprueba justo antes de crear la historia: si se cancelo mientras
      // subia, el archivo queda huerfano pero NO aparece ninguna historia.
      if (cancelado()) throw new PublicacionCancelada();

      // Con tramo, `createStory` va por la API y el servidor recorta ANTES de
      // crear la fila. Si ffmpeg falla, esto lanza y no se publica nada.
      await createStory(
        subido,
        elegido.kind === 'video' && duracion ? duracion : FOTO_MS,
        tramo ?? undefined,
      );
      setElegido(null);
      setRevision(null);
      setTramo(null);
      // El aviso va DESPUES de salir: sobre una pantalla completa el toast
      // quedaria tapado.
      alSalir();
      toast(t('create.storyPublished'));
    });
  }, [elegido, revision, tramo, envio, createStory, alSalir, t]);

  if (!elegido) {
    return (
      <PasoDeCaptura
        duracionMaximaMs={MAX_HISTORIA_MS}
        pie={pie}
        alElegir={elegir}
        alCerrar={alSalir}
        activo={activo}
      />
    );
  }

  // Un video mas largo que el tope NO llega a la pantalla de publicar sin
  // haber elegido tramo: se pinta el recortador y no hay forma de saltarselo
  // salvo volviendo atras.
  if (revision?.estado === 'demasiado-larga' && !tramo) {
    return (
      <RecorteDeHistoria
        uri={elegido.uri}
        duracionMs={revision.durationMs}
        aviso={revision.mensaje}
        alElegir={setTramo}
        alVolver={empezarDeCero}
      />
    );
  }

  return (
    <View style={styles.raiz}>
      {elegido.kind === 'video' ? (
        <VideoPlayer
          uri={elegido.uri}
          // Con tramo elegido, la vista previa empieza donde empieza el tramo.
          // No lo ACOTA —el corte es del servidor— pero al menos enseña la
          // parte que se va a publicar en vez del principio del video.
          startAtSeconds={tramo ? tramo.inicioMs / 1000 : undefined}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          nativeControls={false}
          autoPlay
          loop
        />
      ) : (
        <ExpoImage source={{ uri: elegido.uri }} style={StyleSheet.absoluteFill} contentFit="cover" />
      )}

      <Pressable
        onPress={empezarDeCero}
        hitSlop={12}
        style={styles.volver}
        accessibilityRole="button"
        accessibilityLabel={t('create.chooseSomethingElse')}
      >
        <Feather name="arrow-left" size={24} color={media.text} />
      </Pressable>

      {/*
        LA FRANJA DEL PIE SE APAGA. Es lo que hacia falta para que se lea lo que
        va escrito encima: la foto elegida puede ser blanca, y sobre blanco no
        hay color de letra que valga.
      */}
      <ScrimDeMedio alto={360} />

      <View style={[styles.pie, { bottom: espacioInferior }]}>
        <ProgresoDePublicacion
          fase={envio.fase}
          progreso={envio.progreso}
          error={envio.error}
          puedeReintentar={envio.puedeReintentar}
          alReintentar={envio.reintentar}
          alCancelar={envio.cancelar}
        />
        <Button
          label={t('create.shareToStory')}
          variant="secondary"
          icon="send"
          onPress={publicar}
          loading={envio.ocupado || revision?.estado === 'midiendo'}
          // Mientras se mide no se puede publicar: publicar antes de saber
          // cuanto dura es justo el agujero por el que se colaba un video de
          // cinco minutos.
          disabled={envio.ocupado || revision?.estado === 'midiendo'}
        />
        {tramo ? (
          // El compromiso, otra vez, justo antes del boton: quien publica un
          // tramo de un video largo sube el video largo.
          <SuperficieSobreMedio>
            <Text variant="caption" color={media.text} style={styles.nota}>
              {t('story.trimWholeUploadNotice')}
            </Text>
          </SuperficieSobreMedio>
        ) : null}
        {/*
          «Se verá durante 24 horas»: EL TEXTO DEL INFORME. Iba en gris apagado
          directamente sobre la imagen. Ahora lleva superficie propia, el color
          de texto principal y un reloj, para que la duracion tampoco dependa de
          leer la frase entera.
        */}
        <SuperficieSobreMedio forma="pildora">
          <Feather name="clock" size={13} color={media.text} />
          <Text variant="caption" weight="600" color={media.text} style={styles.nota}>
            {t('create.storyLasts24h')}
          </Text>
        </SuperficieSobreMedio>
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
    // Velo + borde: la flecha tambien va sobre la foto, y sin fondo propio
    // desaparecia en cuanto la esquina de la imagen era clara.
    backgroundColor: media.overlay,
    borderWidth: 1,
    borderColor: media.glassBorder,
  },
  // `bottom` lo pone el componente: depende de cuanto ocupe la barra flotante.
  pie: { position: 'absolute', left: spacing.lg, right: spacing.lg, gap: spacing.sm },
  nota: { textAlign: 'center' },
});
