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
   * Avisa de que el reproductor tuvo que silenciarse para poder arrancar.
   *
   * Los navegadores no dejan que un vídeo empiece con sonido si la persona aún
   * no ha tocado la página. Sin este aviso, el botón de sonido diría que hay
   * audio mientras no se oye nada.
   */
  onMutedChange?: (muted: boolean) => void;
};
