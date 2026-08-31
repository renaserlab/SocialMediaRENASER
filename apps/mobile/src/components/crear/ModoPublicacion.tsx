import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Feather } from '@expo/vector-icons';

import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { Button } from '@/components/Button';
import { useEspacioInferior } from '@/components/espacioInferior';
import { PasoDeCaptura } from '@/components/crear/PasoDeCaptura';
import { ProgresoDePublicacion } from '@/components/crear/ProgresoDePublicacion';
import { SelectorDeTemas } from '@/components/SelectorDeTemas';
import { Text } from '@/components/Text';
import { VideoPlayer } from '@/components/VideoPlayer';
import { usePublicacion, PublicacionCancelada } from '@/hooks/usePublicacion';
import { toast } from '@/lib/toast';
import { uploadPostMedia, type PickedMedia } from '@/services/storage';
import { useAppStore } from '@/store/useAppStore';
import { palette, radius, spacing } from '@/theme/tokens';
import { useTranslation } from '@/i18n/useTranslation';

const media = palette('dark');

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
      toast('Publicado');
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
  return (
    <SinTecladoDelante style={styles.raiz}>
      {elegido ? (
        elegido.kind === 'video' ? (
          <VideoPlayer
            uri={elegido.uri}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            nativeControls={false}
            autoPlay
            loop
            muted
          />
        ) : (
          <ExpoImage
            source={{ uri: elegido.uri }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
          />
        )
      ) : null}

      <Pressable
        onPress={volverAElegir}
        hitSlop={12}
        style={styles.volver}
        accessibilityRole="button"
        accessibilityLabel={elegido ? t('create.chooseSomethingElse') : t('common.back')}
      >
        <Feather name="arrow-left" size={24} color={media.text} />
      </Pressable>

      <View style={[styles.pie, { bottom: espacioInferior }]}>
        <View style={[styles.editor, { borderColor: media.border }]}>
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
          disabled={envio.ocupado || (!elegido && texto.trim().length === 0)}
        />
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
  volver: {
    position: 'absolute',
    top: 54,
    left: spacing.lg,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: media.overlay,
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
});
