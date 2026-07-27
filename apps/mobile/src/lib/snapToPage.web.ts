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
 * `scrollSnapStop: 'always'` es lo que impide saltarse videos. Sin ella, un
 * arrastre fuerte conserva su impulso, recorre varias pantallas y se detiene
 * en la que le pille al frenar: quien queria pasar al siguiente se encontraba
 * dos o tres mas alla, sin saber que se habia perdido. Con ella el navegador
 * esta obligado a parar en cada video, asi que un gesto siempre avanza uno,
 * fuerte o suave.
 *
 * Son propiedades del navegador y no existen en los tipos de React Native, de
 * ahi la conversion; en movil se usa el archivo hermano, que no aplica nada
 * porque alli la lista ya pagina por su cuenta.
 */
export const snapToPage = {
  scrollSnapAlign: 'start',
  scrollSnapStop: 'always',
} as unknown as ViewStyle;
