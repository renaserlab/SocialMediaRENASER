import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Feather } from '@expo/vector-icons';

import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { Button } from '@/components/Button';
import { Pulsable } from '@/components/Pulsable';
import { ESCALA_AL_PULSAR } from '@/lib/movimiento';
import { ScrimDeMedio, sobreMedio } from '@/components/CapaDeContraste';
import { useEspacioInferior } from '@/components/espacioInferior';
import { PasoDeCaptura } from '@/components/crear/PasoDeCaptura';
import { encuadreDePublicacion } from '@/components/PostImage';
import { ProgresoDePublicacion } from '@/components/crear/ProgresoDePublicacion';
import { SelectorDeTemas } from '@/components/SelectorDeTemas';
import { Text } from '@/components/Text';
import { VideoPlayer } from '@/components/VideoPlayer';
import { usePublicacion, PublicacionCancelada } from '@/hooks/usePublicacion';
import { toast } from '@/lib/toast';
import { uploadPostMedia, type PickedMedia } from '@/services/storage';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useTranslation } from '@/i18n/useTranslation';

const media = sobreMedio;

const MAX_TEXTO = 700;

type Props = {
  pie?: React.ReactNode;
  alSalir: () => void;
  /** `false` mientras la pantalla no se esta viendo (ver `PasoDeCaptura`). */
  activo?: boolean;
};

/**
 * Crear una publicacion: elegir o hacer una foto o un video → verlo →
 * describirlo si se quiere → publicar.
 *
 * QUE CAMBIA Y POR QUE. Antes esto era un formulario de texto: un titulo, cuatro
 * etiquetas de tema, un area de escritura grande y tres iconos pequenos para
 * adjuntar. Es decir, el contenido visual —que es el que de verdad se publica en
 * esta aplicacion— entraba por la puerta de servicio. El documento lo senala sin
 * rodeos: esa vista ya no puede ser el nucleo de Crear.
 *
 * Ahora el orden es el mismo que en Historia y en Reel, que es tambien el de las
 * aplicaciones de referencia: primero se elige QUE se publica, y solo despues se
 * decide si lleva texto. Los tres modos comparten `PasoDeCaptura`, de modo que
 * los permisos, la camara y el carrete se resuelven en un unico sitio.
 *
 * PUBLICAR SOLO TEXTO SIGUE EXISTIENDO. Es una capacidad real del backend y
 * quitarla seria perder algo que funciona, pero pasa a ser un camino
 * SECUNDARIO —un enlace, no la pantalla entera—, que es lo que corresponde a su
 * peso dentro del producto.
 *
 * LA DESCRIPCION ES OPCIONAL. Una foto se explica sola; obligar a escribir algo
 * para poder compartirla era un requisito nuestro, no de quien publica. La
 * migracion 0022 lo admite en la base de datos y el backend comprueba que al
 * menos haya texto O medio.
 */
export function ModoPublicacion({ pie, alSalir, activo = true }: Props) {
  const { t } = useTranslation();
  const createPost = useAppStore((state) => state.createPost);
  /*
    El pie se apoya en la barra flotante, no en un numero.

    Estaba en `bottom: 44` y la capsula de secciones ocupa entre 78 y 104 px
    segun el aparato: el boton de publicar quedaba DEBAJO de ella siempre, y
    como la barra se pinta encima y se queda el toque, pulsarlo cambiaba de
    seccion. Ahora la medida sale del mismo sitio que la dibuja.
  */
  const espacioInferior = useEspacioInferior();

  const [elegido, setElegido] = useState<PickedMedia | null>(null);
  /** Camino secundario: publicar sin foto ni video. */
  const [soloTexto, setSoloTexto] = useState(false);
  const [texto, setTexto] = useState('');
  /** De que trata: ids de la taxonomia comun. Etiquetar es opcional. */
  const [temas, setTemas] = useState<string[]>([]);
  const envio = usePublicacion();

  const publicar = useCallback(() => {
    const cuerpo = texto.trim();
    if (!elegido && !cuerpo) return;

    void envio.ejecutar(async ({ avance, cancelado }) => {
      const subidos = elegido ? [await uploadPostMedia(elegido, avance)] : [];
      if (cancelado()) throw new PublicacionCancelada();

      await createPost(cuerpo, subidos, temas);
      setElegido(null);
      setTexto('');
      setTemas([]);
      setSoloTexto(false);
      alSalir();
      toast(t('create.postPublished'));
    });
  }, [elegido, texto, temas, envio, createPost, alSalir]);

  const volverAElegir = useCallback(() => {
    envio.limpiar();
    setElegido(null);
    setSoloTexto(false);
    setTexto('');
    setTemas([]);
  }, [envio]);

  /* ------------------------------------------------------------ elegir --- */
  if (!elegido && !soloTexto) {
    return (
      <PasoDeCaptura
        duracionMaximaMs={MAX_PUBLICACION_MS}
        /*
          UNA PUBLICACION NO SE RECORTA. El muro la encuadra respetando su forma
          (ver `PostImage`), asi que pedirle a la persona un recorte 9:16 de
          historia era exigirle que sacrificara los lados para nada.
        */
        recorte="ninguno"
        pie={pie}
        alElegir={setElegido}
        alCerrar={alSalir}
        activo={activo}
        /*
          El camino de solo texto se ofrece AQUI, junto al carrete, no como una
          pantalla aparte: es una alternativa a elegir un medio, y ese es el
          momento en que la decision tiene sentido.
        */
        alternativa={{ etiqueta: t('create.writeWithoutPhoto'), alPulsar: () => setSoloTexto(true) }}
      />
    );
  }

  /* --------------------------------------------------- revisar y publicar --- */
  /*
    LA PREVIA TIENE QUE ENSENAR LO QUE SE VA A PUBLICAR, y no lo hacia.

    Se pintaba `cover` a pantalla completa: sobre una pantalla de movil eso
    recorta los lados de casi cualquier foto, asi que quien publicaba componia
    una imagen que el muro luego no reproducia —el muro la ensena entera salvo
    que sea extremadamente alargada—. De ahi la pregunta del cliente: «al
    publicar ya no aparece un recortador de fotos, ¿no?». No lo hay, y por eso
    justamente la previa no podia comportarse como si lo hubiera.

    Ahora se encuadra con la MISMA funcion que decide el recorte del muro, asi
    que lo que se ve aqui es lo que sale alli. Sin medidas —la camara del
    aparato no siempre las informa— se cae a `contain`, que ensena la foto
    entera: equivocarse ensenando de mas es recuperable; de menos, no.
  */
  const encuadre = elegido?.kind === 'image' ? encuadreDePublicacion(elegido.width, elegido.height) : null;
  /** Solo texto y todavia vacio: lo unico que impide publicar. */
  const faltaTexto = !elegido && texto.trim().length === 0;

  return (
    <SinTecladoDelante style={styles.raiz}>
      {elegido ? (
        elegido.kind === 'video' ? (
          <VideoPlayer
            uri={elegido.uri}
            style={StyleSheet.absoluteFill}
            // `contain`, igual que en la tarjeta del muro: un video vertical
            // recortado por los lados no se parece a lo que se va a publicar.
            contentFit="contain"
            nativeControls={false}
            autoPlay
            loop
            muted
          />
        ) : encuadre ? (
          <View style={styles.marco}>
            <ExpoImage
              source={{ uri: elegido.uri }}
              style={{ width: '100%', aspectRatio: encuadre }}
              contentFit="cover"
            />
          </View>
        ) : (
          <ExpoImage
            source={{ uri: elegido.uri }}
            style={StyleSheet.absoluteFill}
            contentFit="contain"
          />
        )
      ) : null}

      <Pulsable
        onPress={volverAElegir}
        hitSlop={12}
        escala={ESCALA_AL_PULSAR.icono}
        style={styles.volver}
        accessibilityRole="button"
        accessibilityLabel={elegido ? t('create.chooseSomethingElse') : t('common.back')}
      >
        <Feather name="arrow-left" size={24} color={media.text} />
      </Pulsable>

      {/*
        LA FRANJA DEL PIE SE APAGA. El editor, los temas, el aviso de subida y
        el boton van todos encima del medio, que puede ser claro.
      */}
      <ScrimDeMedio alto={440} />

      <View style={[styles.pie, { bottom: espacioInferior }]}>
        <View style={[styles.editor, { borderColor: media.glassBorder }]}>
          <TextInput
            value={texto}
            onChangeText={setTexto}
            placeholder={elegido ? t('create.addCaption') : t('create.whatToShare')}
            placeholderTextColor={media.textMuted}
            multiline
            maxLength={MAX_TEXTO}
            textAlignVertical="top"
            style={[styles.entrada, { color: media.text }]}
            accessibilityLabel={t('create.postDescription')}
            autoFocus={!elegido}
          />
          <Text variant="caption" color={media.textMuted} style={styles.contador}>
            {texto.length}/{MAX_TEXTO}
          </Text>
        </View>

        {/*
          Debajo del editor y no encima: los temas afinan lo que ya se ha
          contado, y asi quedan al alcance del pulgar, pegados a Publicar.
        */}
        <SelectorDeTemas seleccionados={temas} alCambiar={setTemas} variante="sobreMedia" />

        <ProgresoDePublicacion
          fase={envio.fase}
          progreso={envio.progreso}
          error={envio.error}
          puedeReintentar={envio.puedeReintentar}
          alReintentar={envio.reintentar}
          alCancelar={envio.cancelar}
        />

        <Button
          label={t('common.publish')}
          variant="secondary"
          icon="send"
          onPress={publicar}
          loading={envio.ocupado}
          // Sin medio hace falta texto; con medio, el texto sobra.
          disabled={envio.ocupado || faltaTexto}
        />
        {/*
          UN BOTON APAGADO TIENE QUE DECIR POR QUE. Sin esta linea, «Publicar»
          en gris parecia roto: no habia forma de saber que lo unico que falta
          es escribir algo.
        */}
        {faltaTexto && !envio.ocupado ? (
          <Text
            variant="caption"
            color={media.textMuted}
            style={styles.porQueApagado}
            accessibilityLiveRegion="polite"
          >
            {t('create.writeToPublish')}
          </Text>
        ) : null}
      </View>
    </SinTecladoDelante>
  );
}

/**
 * Tope de video en una publicacion.
 *
 * El mismo que un reel: por debajo es la misma tuberia de video y el mismo
 * compresor del dispositivo, asi que dos limites distintos solo serviran para
 * que uno de los dos se quede sin actualizar.
 */
const MAX_PUBLICACION_MS = 180_000;

const styles = StyleSheet.create({
  raiz: { flex: 1, backgroundColor: media.background },
  // El encuadre real, centrado: lo que queda fuera no se publica.
  marco: { ...StyleSheet.absoluteFillObject, justifyContent: 'center' },
  volver: {
    position: 'absolute',
    top: 54,
    left: spacing.lg,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    // Velo + borde: la flecha va sobre el medio y sin fondo propio se pierde
    // en cuanto la esquina es clara.
    backgroundColor: media.overlay,
    borderWidth: 1,
    borderColor: media.glassBorder,
  },
  // `bottom` lo pone el componente: depende de cuanto ocupe la barra flotante.
  pie: { position: 'absolute', left: spacing.lg, right: spacing.lg, gap: spacing.sm },
  editor: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
    backgroundColor: media.overlay,
    maxHeight: 160,
  },
  entrada: { fontSize: 15, lineHeight: 21, minHeight: 44 },
  contador: { textAlign: 'right', marginTop: spacing.xs },
  porQueApagado: { textAlign: 'center' },
});
