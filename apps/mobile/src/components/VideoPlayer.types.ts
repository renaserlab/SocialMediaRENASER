import type { ImageSourcePropType, StyleProp, ViewStyle } from 'react-native';

export type VideoPlayerProps = {
  /** URL o fuente del video. */
  uri: string;
  /** Póster mostrado antes de reproducir (tratamiento B&N vía scrim). */
  poster?: ImageSourcePropType;
  /**
   * Clave estable para la cache de disco del poster (su ruta en Storage).
   * La URL firmada cambia con cada firma; sin esto, cada refirma volvia a
   * descargar la misma miniatura.
   */
  posterCacheKey?: string;
  /**
   * Guarda el video en la cache de disco de expo-video: el segundo visionado
   * no vuelve a la red. Solo para fuentes MP4 (la cache no soporta HLS en
   * iOS); el que llama decide segun el tipo de fuente.
   */
  cacheToDisk?: boolean;
  style?: StyleProp<ViewStyle>;
  loop?: boolean;
  autoPlay?: boolean;
  muted?: boolean;
  contentFit?: 'cover' | 'contain' | 'fill';
  /** Muestra los controles nativos una vez iniciada la reproducción. */
  nativeControls?: boolean;
  /**
   * Reproducción por viewport (feeds tipo reels): `true` reproduce, `false`
   * pausa. Si es `undefined`, el control queda a cargo de autoPlay/usuario.
   */
  active?: boolean;
  /**
   * Solo PAUSA cuando el vídeo deja de verse; nunca lo arranca al aparecer.
   *
   * Es lo que necesita un muro, donde el vídeo lo pone la persona y empezar
   * solo al desplazarse seria intrusivo y gastaria datos. Sin esto, un vídeo
   * seguía sonando y decodificando después de haberlo dejado atrás.
   *
   * Se distingue de `active` a propósito: ese sí reproduce al entrar, que es lo
   * que quiere Shorts.
   */
  visible?: boolean;
  /**
   * Controles propios para video vertical a pantalla completa: un toque en
   * cualquier parte pausa o reanuda, y abajo aparece una barra de progreso que
   * se puede arrastrar.
   *
   * Sustituye a `nativeControls`, que sobre un vídeo a pantalla completa tapa
   * el contenido con una botonera pensada para un reproductor con marco.
   */
  shortsControls?: boolean;
  /** Separación de la barra de progreso respecto al borde inferior. */
  controlsBottomInset?: number;
  /**
   * Quita el circulo de reproduccion del centro.
   *
   * En un muro que reproduce SOLO, ese boton es una instruccion falsa: anuncia
   * que hay que pulsar algo cuando en realidad el video va a empezar por su
   * cuenta. Lo unico que consigue es que el video parezca parado durante el
   * medio segundo que tarda en arrancar (justo lo que se ve en la captura del
   * documento). Fuera del muro —formato corto, detalle— el circulo sigue
   * teniendo sentido: ahi la pausa la decide la persona.
   *
   * Ojo: solo esconde el circulo mientras nadie ha tocado el video. Si la
   * persona lo pausa a proposito, vuelve a aparecer; si no, no habria forma de
   * saber que esta pausado ni de reanudarlo.
   */
  hidePlayButton?: boolean;
  /**
   * Avisa de que el reproductor tuvo que silenciarse para poder arrancar.
   *
   * Los navegadores no dejan que un vídeo empiece con sonido si la persona aún
   * no ha tocado la página. Sin este aviso, el botón de sonido diría que hay
   * audio mientras no se oye nada.
   */
  onMutedChange?: (muted: boolean) => void;
  /**
   * Segundo por el que empezar. Es lo que convierte «volver al curso» en
   * seguir donde se dejo en vez de volver al principio.
   *
   * Solo se aplica UNA vez, al estar listo el video: aplicarlo en cada cambio
   * devolveria a la persona al punto guardado justo despues de rebobinar.
   */
  startAtSeconds?: number;
  /**
   * Por donde va, en segundos, cada pocos segundos.
   *
   * NO es una peticion por segundo: quien lo recibe decide cada cuanto
   * guardar. Aqui solo se avisa.
   */
  onProgressSeconds?: (seconds: number) => void;
  /** El video llego al final. Lo sabe el reproductor y nadie mas. */
  onEnded?: () => void;
  /**
   * Ya se ve el primer fotograma.
   *
   * Es el «listo» que le importa a quien mide el tiempo desde fuera: el visor
   * de historias no empieza a contar el tramo hasta que hay algo en pantalla.
   * Sin esto contaba desde que se montaba el reproductor, y el segundo que
   * tarda un video en arrancar se descontaba del tramo.
   */
  onFirstFrame?: () => void;
  /**
   * Medir cuanto tarda este video en reproducir de verdad (Inicio en
   * telefonos, `lib/medicionDeVideo`). `id` solo sirve para saber de que
   * reproductor viene cada aviso; no sale del telefono. Sin esta prop, el
   * reproductor no informa de nada.
   */
  medirComo?: { id: string; hls: boolean; bytes?: number | null; almacen?: 'supabase' | 's3' };
};
