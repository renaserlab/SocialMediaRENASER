import type { ImageSourcePropType, StyleProp, ViewStyle } from 'react-native';

export type VideoPlayerProps = {
  /** URL o fuente del video. */
  uri: string;
  /** Póster mostrado antes de reproducir (tratamiento B&N vía scrim). */
  poster?: ImageSourcePropType;
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
