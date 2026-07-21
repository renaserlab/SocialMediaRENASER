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
};
