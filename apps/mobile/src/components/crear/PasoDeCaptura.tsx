import React, { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { AvisoDePermiso } from '@/components/AvisoDePermiso';
import { espacioParaLaBarra } from '@/components/FloatingGlassTabBar';
import { Text } from '@/components/Text';
import { consultarPermiso, pedirPermiso, type EstadoDePermiso } from '@/lib/permisos';
import { lastGalleryPhoto, StoryCaptureScreen } from '@/screens/StoryCaptureScreen';
import { StoryGalleryScreen } from '@/screens/StoryGalleryScreen';
import { pickImage, pickVideo, PermisoDenegadoError, type PickedMedia } from '@/services/storage';
import { palette, radius, spacing } from '@/theme/tokens';

const media = palette('dark');

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
};

/**
 * Elegir o grabar lo que se va a publicar.
 *
 * Es la parte que comparten Historia y Reel, y por eso vive aqui: la camara,
 * la cuadricula del carrete y el reparto de permisos son exactamente los
 * mismos; lo unico que cambia es que se hace despues con lo capturado.
 *
 * PERMISOS AL USARLOS, NO AL ENTRAR. Nada se pide hasta que la persona toca
 * algo que lo necesita, y cuando falta se explica con salida: volver a pedirlo
 * si el sistema todavia deja, ir a los ajustes cuando ya no, o hacerlo por el
 * otro camino (el carrete no necesita camara).
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
}: Props) {
  const enWeb = Platform.OS === 'web';
  const [paso, setPaso] = useState<'camara' | 'galeria'>(enWeb ? 'galeria' : 'camara');
  const [ultimaFoto, setUltimaFoto] = useState<string | null>(null);
  const [permisoCamara, setPermisoCamara] = useState<EstadoDePermiso | null>(null);

  // Miniatura del acceso al carrete. Sin permiso queda a null y se pinta un
  // icono; no es un error que deba interrumpir nada.
  useEffect(() => {
    if (enWeb) return;
    void lastGalleryPhoto().then(setUltimaFoto);
  }, [enWeb]);

  // Se consulta SIN pedir: pedirlo solo por entrar es lo que hace que se
  // rechace, y en iOS un rechazo no tiene vuelta atras dentro de la app.
  useEffect(() => {
    if (enWeb || paso !== 'camara' || !activo) return;
    void consultarPermiso('camara').then(setPermisoCamara);
  }, [enWeb, paso, activo]);

  const pedirCamara = useCallback(() => {
    void pedirPermiso('camara').then(setPermisoCamara);
  }, []);

  /* ------------------------------------------------------------ web ------ */
  const [errorWeb, setErrorWeb] = useState<string | null>(null);
  const elegirEnWeb = useCallback(
    async (tipo: 'imagen' | 'video') => {
      try {
        setErrorWeb(null);
        const elegido = tipo === 'video' ? await pickVideo() : await pickImage();
        if (elegido) alElegir(elegido);
      } catch (e) {
        setErrorWeb(
          e instanceof PermisoDenegadoError
            ? e.message
            : 'No se pudo abrir el selector. Inténtalo de nuevo.',
        );
      }
    },
    [alElegir],
  );

  if (enWeb) {
    return (
      <View style={styles.raiz}>
        <View style={styles.centro}>
          <View style={[styles.icono, { borderColor: media.border }]}>
            <Feather name={soloVideo ? 'video' : 'image'} size={26} color={media.text} />
          </View>
          <Text variant="title" weight="800" color={media.text} style={styles.centrado}>
            {soloVideo ? 'Elige un vídeo' : 'Elige una foto o un vídeo'}
          </Text>
          <Text variant="body" color={media.textMuted} style={styles.centrado}>
            Desde el navegador se usa el selector de archivos de tu equipo.
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
                Elegir vídeo
              </Text>
            </Pressable>
            {!soloVideo ? (
              <Pressable
                onPress={() => void elegirEnWeb('imagen')}
                style={[styles.boton, styles.secundario, { borderColor: media.border }]}
                accessibilityRole="button"
              >
                <Text variant="body" weight="700" color={media.text}>
                  Elegir foto
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
        {pie ? <View style={styles.pieWeb}>{pie}</View> : null}
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
          alternativa={{ etiqueta: 'Elegir del carrete', alPulsar: () => setPaso('galeria') }}
        />
        {pie ? <View style={styles.pieWeb}>{pie}</View> : null}
      </View>
    );
  }

  // Sin foco no se monta la camara. Se deja el fondo, que es lo que ya se
  // veria: nadie esta mirando esta pantalla.
  if (!activo) return <View style={styles.raiz} />;

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
  pieWeb: { paddingBottom: espacioParaLaBarra(0) },
});
