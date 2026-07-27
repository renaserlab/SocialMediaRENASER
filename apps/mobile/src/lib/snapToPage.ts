import type { ViewStyle } from 'react-native';

/**
 * Anclaje de cada video a pantalla completa en el feed vertical.
 *
 * En movil no hace falta nada: `pagingEnabled` ya hace que la lista se detenga
 * en un video completo y avance de uno en uno. Es en el navegador donde hay
 * que pedirlo a mano, asi que los estilos de verdad estan en
 * `snapToPage.web.ts`.
 */
export const snapToPage: ViewStyle = {};
