import type { ViewStyle } from 'react-native';

/**
 * Anclaje de cada video a pantalla completa en el feed vertical (web).
 *
 * `pagingEnabled` pide al navegador que la lista se detenga siempre en un
 * punto de anclaje, pero NO marca donde estan esos puntos: solo lo hace en los
 * hijos directos del contenedor con scroll, y en una lista virtualizada ese
 * hijo unico es la caja que envuelve TODOS los videos.
 *
 * El resultado era un unico punto de anclaje, el principio de la lista: un
 * arrastre corto se quedaba parado a mitad de camino, ensenando medio video y
 * medio el siguiente.
 *
 * Marcando cada video se consigue un anclaje por video, que es lo que hace
 * falta para que el gesto siempre acabe en uno entero. De paso, un simple
 * toque no mueve nada: sin desplazamiento no hay nada que anclar.
 *
 * `scrollSnapAlign` es propiedad del navegador y no existe en los tipos de
 * React Native, de ahi la conversion; en movil se usa el archivo hermano, que
 * no aplica nada.
 */
export const snapToPage = { scrollSnapAlign: 'start' } as unknown as ViewStyle;
