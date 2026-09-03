import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';

import { AvisoDePermiso } from '@/components/AvisoDePermiso';
import { sobreMedio } from '@/components/CapaDeContraste';
import { useEspacioInferior } from '@/components/espacioInferior';
import { Text } from '@/components/Text';
import { consultarPermiso, pedirPermiso, type EstadoDePermiso } from '@/lib/permisos';
import {
  alturaDelSelector,
  lastGalleryPhoto,
  StoryCaptureScreen,
} from '@/screens/StoryCaptureScreen';
import { StoryGalleryScreen } from '@/screens/StoryGalleryScreen';
import { pickImage, pickVideo, PermisoDenegadoError, type PickedMedia } from '@/services/storage';
import { radius, spacing } from '@/theme/tokens';
import { useTranslation } from '@/i18n/useTranslation';

// Un unico origen para «lo que va encima de un medio»: la camara y el carrete
// son contexto oscuro en los dos temas, igual que el resto del flujo de crear.
const media = sobreMedio;

type Props = {
  /** Reel: solo video. Historia y publicacion: foto o video. */
  soloVideo?: boolean;
  /** Tope de grabacion con camara. */
  duracionMaximaMs: number;
  /** Selector de modo, que se pinta dentro de la camara. */
  pie?: React.ReactNode;
  alElegir: (elegido: PickedMedia) => void;
  alCerrar: () => void;
  /**
   * `false` mientras la pantalla no se esta viendo.
   *
   * Crear vive dentro del carrusel de secciones, y el carrusel PREPARA las
   * secciones vecinas para que aparezcan al instante al arrastrar. Sin esta
   * condicion, quedarse en modo Historia y deslizar a Explorar dejaba la
   * camara abierta por detras: bateria, calor y el piloto de camara encendido
   * en una pantalla que ni siquiera se ve.
   */
  activo?: boolean;
  /**
   * Salida secundaria junto al carrete (por ejemplo, «Escribir sin foto»).
   *
   * Va aqui y no en una pantalla aparte porque es una ALTERNATIVA a elegir un
   * medio, y este es el momento en que esa decision tiene sentido.
   */
  alternativa?: { etiqueta: string; alPulsar: () => void };
  /**
   * Encuadre que pide el selector del sistema. Historia y Reel son verticales;
   * una publicacion no, y forzarle 9:16 le recortaba la foto sin avisar.
   */
  recorte?: [number, number] | 'ninguno';
};

/**
 * Elegir o grabar lo que se va a publicar.
 *
 * Es la parte que comparten Historia y Reel, y por eso vive aqui: la camara,
 * la cuadricula del carrete y el reparto de permisos son exactamente los
 * mismos; lo unico que cambia es que se hace despues con lo capturado.
 *
 * PERMISOS AL USARLOS, NO AL ENTRAR. Nada se pide al arrancar la aplicacion:
 * el de camara se pide al llegar a este paso —que es cuando hace falta— y solo
 * si no se habia preguntado nunca; el de microfono lo pide la camara al empezar
 * a grabar, y el del carrete lo pide la cuadricula al abrirse. Cuando falta se
 * explica con salida: volver a pedirlo si el sistema todavia deja, ir a los
 * ajustes cuando ya no, o hacerlo por el otro camino (el carrete no necesita
 * camara).
 *
 * Y SE PIDE DESDE UN SOLO SITIO: este. Ver el comentario del efecto de abajo —
 * tener dos duenos del mismo permiso fue la causa de que la camara no
 * apareciera.
 *
 * EN EL NAVEGADOR no hay camara ni carrete que recorrer, asi que se usa el
 * selector de archivos, que es lo que el navegador si sabe hacer. Es
 * deliberado: montar una camara web a medias daria una experiencia peor que la
 * nativa del propio navegador.
 */
export function PasoDeCaptura({
  soloVideo = false,
  duracionMaximaMs,
  pie,
  alElegir,
  alCerrar,
  activo = true,
  alternativa,
  recorte = [9, 16],
}: Props) {
  const { t } = useTranslation();
  const enWeb = Platform.OS === 'web';
  const insets = useSafeAreaInsets();
  /*
    Cuanto ocupa la barra flotante, contando la zona segura DE ESTE aparato.

    Antes era `espacioParaLaBarra(0)` escrito en la hoja de estilos, es decir,
    la barra medida como si el telefono no tuviera indicador de inicio: se
    reservaban 78 px donde hacian falta 104 y el selector volvia a asomar por
    debajo de la capsula en cuanto habia muesca.
  */
  const espacioInferior = useEspacioInferior();
  const [paso, setPaso] = useState<'camara' | 'galeria'>(enWeb ? 'galeria' : 'camara');
  const [ultimaFoto, setUltimaFoto] = useState<string | null>(null);
  const [permisoCamara, setPermisoCamara] = useState<EstadoDePermiso | null>(null);

  // Miniatura del acceso al carrete. Sin permiso queda a null y se pinta un
  // icono; no es un error que deba interrumpir nada.
  useEffect(() => {
    if (enWeb) return;
    void lastGalleryPhoto().then(setUltimaFoto);
  }, [enWeb]);

  /**
   * EL PERMISO DE CAMARA SE LLEVA AQUI, Y EN UN SOLO SITIO.
   *
   * Antes habia DOS duenos y se pisaban. Esta pantalla consultaba el permiso
   * (sin pedirlo) mientras `StoryCaptureScreen`, ya montada debajo, lo PEDIA
   * sola nada mas aparecer. Lo que pasaba, en este orden: saltaba el dialogo
   * del sistema; la consulta de aqui resolvia «todavia no concedido» y
   * DESMONTABA la camara con el dialogo abierto; la respuesta —incluido un
   * «permitir»— llegaba a un componente que ya no existia, y este estado se
   * quedaba clavado en la pantalla de aviso. La camara no volvia a aparecer.
   *
   * En Android era peor: el efecto de alla dependia del propio permiso, asi
   * que cada «no» relanzaba el dialogo. Dos noes seguidos y el sistema deja de
   * preguntar PARA SIEMPRE; a partir de ahi la camara ya no aparecia nunca y
   * no habia forma de arreglarlo desde dentro de la aplicacion.
   *
   * CUANDO SE PIDE. Al llegar al paso de camara y solo si no se ha preguntado
   * nunca, que es exactamente el momento en que hace falta: Crear → cámara →
   * permiso. No al arrancar la aplicacion, y nunca sobre un «no» ya dado —eso
   * lo decide la persona pulsando en el aviso—.
   */
  const pidiendo = useRef(false);
  useEffect(() => {
    if (enWeb || paso !== 'camara' || !activo) return;
    let vigente = true;

    void (async () => {
      try {
        const estado = await consultarPermiso('camara');
        if (!vigente) return;
        setPermisoCamara(estado);

        /*
          Primera vez: se pide aqui mismo. El `ref` evita que un segundo pase
          del efecto —volver del segundo plano, por ejemplo— lance un dialogo
          encima de otro que ya esta abierto.
        */
        if (estado === 'sinPreguntar' && !pidiendo.current) {
          pidiendo.current = true;
          try {
            const respuesta = await pedirPermiso('camara');
            if (vigente) setPermisoCamara(respuesta);
          } finally {
            pidiendo.current = false;
          }
        }
      } catch {
        /*
          Si el modulo de permisos falla, se cae al aviso —que tiene boton y
          salida por el carrete— y NO a una pantalla negra sin nada que tocar.
          Quedarse en `null` dejaba justo eso.
        */
        if (vigente) setPermisoCamara('denegado');
      }
    })();

    return () => {
      vigente = false;
    };
    /*
      `activo` en las dependencias es lo que cumple la promesa del aviso
      («volvemos aquí en cuanto lo hagas»): al volver de los ajustes del
      telefono la pantalla se reactiva, el permiso se vuelve a leer y la camara
      aparece sola. Antes el estado se leia UNA vez y no se miraba nunca mas,
      asi que conceder el permiso fuera no servia de nada: habia que cerrar la
      aplicacion entera.
    */
  }, [enWeb, paso, activo]);

  /**
   * Pedirlo a peticion de la persona, desde el aviso.
   *
   * Comparte el cerrojo con el efecto: en iOS el dialogo del sistema deja la
   * aplicacion «inactiva», eso reactiva el efecto al cerrarse y sin el cerrojo
   * podrian solaparse dos peticiones. En Android cada peticion de mas gasta uno
   * de los dos intentos que da el sistema antes de bloquear el permiso para
   * siempre.
   */
  const pedirCamara = useCallback(() => {
    if (pidiendo.current) return;
    pidiendo.current = true;
    void pedirPermiso('camara')
      .then(setPermisoCamara)
      .catch(() => setPermisoCamara('denegado'))
      .finally(() => {
        pidiendo.current = false;
      });
  }, []);

  /* ------------------------------------------------------------ web ------ */
  const [errorWeb, setErrorWeb] = useState<string | null>(null);
  const elegirEnWeb = useCallback(
    async (tipo: 'imagen' | 'video') => {
      try {
        setErrorWeb(null);
        const elegido =
          tipo === 'video'
            ? await pickVideo()
            : await pickImage(
                recorte === 'ninguno' ? { allowsEditing: false } : { aspect: recorte },
              );
        if (elegido) alElegir(elegido);
      } catch (e) {
        setErrorWeb(
          e instanceof PermisoDenegadoError
            ? e.message
            : t('media.pickerFailed'),
        );
      }
    },
    [alElegir, recorte],
  );

  if (enWeb) {
    return (
      <View style={styles.raiz}>
        <View style={styles.centro}>
          <View style={[styles.icono, { borderColor: media.border }]}>
            <Feather name={soloVideo ? 'video' : 'image'} size={26} color={media.text} />
          </View>
          <Text variant="title" weight="800" color={media.text} style={styles.centrado}>
            {soloVideo ? t('media.chooseVideo') : t('media.choosePhotoOrVideo')}
          </Text>
          <Text variant="body" color={media.textMuted} style={styles.centrado}>
            {t('media.webPickerNote')}
          </Text>
          {errorWeb ? (
            <Text variant="secondary" weight="700" color={media.danger} style={styles.centrado}>
              {errorWeb}
            </Text>
          ) : null}
          <View style={styles.acciones}>
            <Pressable
              onPress={() => void elegirEnWeb('video')}
              style={[styles.boton, { backgroundColor: media.text }]}
              accessibilityRole="button"
            >
              <Text variant="body" weight="700" color={media.background}>
                {t('media.pickVideo')}
              </Text>
            </Pressable>
            {!soloVideo ? (
              <Pressable
                onPress={() => void elegirEnWeb('imagen')}
                style={[styles.boton, styles.secundario, { borderColor: media.border }]}
                accessibilityRole="button"
              >
                <Text variant="body" weight="700" color={media.text}>
                  {t('media.pickPhoto')}
                </Text>
              </Pressable>
            ) : null}
          </View>
          {alternativa ? (
            <Pressable onPress={alternativa.alPulsar} hitSlop={8} accessibilityRole="button">
              <Text variant="secondary" weight="700" color={media.textMuted} style={styles.enlace}>
                {alternativa.etiqueta}
              </Text>
            </Pressable>
          ) : null}
        </View>
        {pie ? <View style={[styles.pieWeb, { paddingBottom: espacioInferior }]}>{pie}</View> : null}
      </View>
    );
  }

  /* --------------------------------------------------------- galeria ----- */
  if (paso === 'galeria') {
    return (
      <StoryGalleryScreen
        onSelect={alElegir}
        onClose={alCerrar}
        onOpenCamera={() => setPaso('camara')}
        soloVideo={soloVideo}
        pie={pie}
        alternativa={alternativa}
        recorte={recorte}
      />
    );
  }

  /* ---------------------------------------------------------- camara ----- */
  // Denegada o bloqueada: se explica y se ofrece el carrete, que no necesita
  // camara. Antes esto era una pantalla sin nada que tocar.
  if (permisoCamara === 'denegado' || permisoCamara === 'bloqueado') {
    return (
      <View style={styles.raiz}>
        <AvisoDePermiso
          tipo="camara"
          estado={permisoCamara}
          alPedir={pedirCamara}
          alternativa={{
            etiqueta: t('media.pickFromGallery'),
            alPulsar: () => setPaso('galeria'),
          }}
        />
        {pie ? <View style={[styles.pieWeb, { paddingBottom: espacioInferior }]}>{pie}</View> : null}
      </View>
    );
  }

  // Sin foco no se monta la camara. Se deja el fondo, que es lo que ya se
  // veria: nadie esta mirando esta pantalla.
  if (!activo) return <View style={styles.raiz} />;

  /*
    Todavia sin respuesta: o se esta leyendo el estado (`null`) o el dialogo del
    sistema esta abierto encima («sinPreguntar»). Se deja el fondo oscuro de la
    camara, que es justo lo que hay detras del dialogo.

    Es lo que evita el fallo de antes: montar `CameraView` sin permiso concedido
    la dejaba en negro y, sobre todo, arrancaba su propia peticion de permiso en
    paralelo a la de aqui. Ahora la camara solo se monta cuando de verdad puede
    ensenar imagen.
  */
  if (permisoCamara !== 'concedido') {
    return (
      <View style={styles.raiz}>
        {pie ? (
          <View style={[styles.piePendiente, { bottom: alturaDelSelector(insets.bottom) }]}>
            {pie}
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <StoryCaptureScreen
      onCaptured={alElegir}
      onOpenGallery={() => setPaso('galeria')}
      onClose={alCerrar}
      lastPhotoUri={ultimaFoto}
      duracionMaximaMs={duracionMaximaMs}
      pie={pie}
    />
  );
}

const styles = StyleSheet.create({
  raiz: { flex: 1, backgroundColor: media.background },
  centro: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  enlace: { textDecorationLine: 'underline', marginTop: spacing.md },
  icono: {
    width: 58,
    height: 58,
    borderRadius: 29,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  centrado: { textAlign: 'center' },
  acciones: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg, flexWrap: 'wrap', justifyContent: 'center' },
  boton: {
    borderRadius: radius.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    minHeight: 44,
    justifyContent: 'center',
  },
  secundario: { borderWidth: 1 },
  /*
    El selector se aparta de la barra de secciones.

    Antes eran 24 px, es decir, DENTRO de la franja que ocupa la barra flotante:
    la fila quedaba por detras de la capsula y lo unico que asomaba era el
    trocito de etiqueta que sobresalia por su izquierda. Eso es el texto suelto
    y cortado que aparece junto a la barra en el documento. Se apoya en la misma
    medida que usa la barra para saber cuanto ocupa.
  */
  // `paddingBottom` lo pone el componente: sale de `useEspacioInferior`.
  pieWeb: {},
  /*
    El selector mientras el permiso se resuelve.

    A la MISMA altura a la que lo pinta la camara (`pie` de
    `StoryCaptureScreen`), para que al conceder el permiso la fila de modos no
    de un salto: lo unico que cambia es que detras aparece la imagen.
  */
  piePendiente: { position: 'absolute', left: 0, right: 0 },
});
