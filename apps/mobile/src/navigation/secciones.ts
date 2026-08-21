import type { Feather } from '@expo/vector-icons';

/**
 * Las secciones principales, en su orden, y una sola vez.
 *
 * Antes esta lista existia por duplicado: el orden de los `Tabs.Screen` del
 * layout y el mapa de iconos de la barra flotante. Mientras solo servia para
 * pintar iconos daba igual; ahora tambien decide en que POSICION queda cada
 * pantalla dentro del carrusel, asi que dos listas que se puedan desfasar son
 * un error esperando a ocurrir: bastaria con anadir una seccion en un sitio y
 * no en el otro para que la barra senalara una pestana y el dedo llevara a
 * otra.
 *
 * `nombre` es el nombre de ruta de expo-router (el fichero dentro de `(tabs)`).
 */
export const SECCIONES = [
  { nombre: 'home', icono: 'home' },
  { nombre: 'explore', icono: 'search' },
  { nombre: 'create', icono: 'plus-square' },
  { nombre: 'messages', icono: 'message-square' },
  { nombre: 'profile/index', icono: 'user' },
] as const satisfies ReadonlyArray<{ nombre: string; icono: keyof typeof Feather.glyphMap }>;

/** Solo los nombres, para buscar posiciones. */
export const ORDEN_SECCIONES: readonly string[] = SECCIONES.map((s) => s.nombre);

/**
 * Posicion de una ruta dentro del carrusel, o -1 si no es una seccion.
 *
 * Dentro de las pestanas tambien viven destinos que NO son seccion (el perfil
 * de otra persona, un circulo, un audio, las listas de seguidores). Estan ahi
 * para que la barra flotante no desaparezca al abrirlos, y no deben formar
 * parte del carrusel: deslizar desde Perfil no puede llevar al perfil de un
 * desconocido sin parametros.
 */
export function posicionDeSeccion(nombreDeRuta: string): number {
  return ORDEN_SECCIONES.indexOf(nombreDeRuta);
}
