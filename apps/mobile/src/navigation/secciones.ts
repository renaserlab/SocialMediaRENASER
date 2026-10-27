import type Feather from '@expo/vector-icons/Feather';

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

/**
 * Secciones que ponen SU barra donde va la de secciones, y por eso la retiran.
 *
 * Hoy solo Crear: sus cuatro tipos de publicacion (Publicacion · Historia ·
 * Reel · Vivo) van en una barra propia abajo, y dos barras flotantes a la vez
 * —la una encima de la otra— no se entienden. En todas las demas secciones la
 * barra de siempre sigue donde estaba.
 *
 * Vive aqui, junto a la lista, para que la decision dependa solo de EN QUE
 * SECCION se esta: es un dato de navegacion, no algo que una pantalla tenga
 * que acordarse de encender al entrar y de apagar al salir.
 */
const CON_BARRA_PROPIA: readonly string[] = ['create'];

export function traeSuPropiaBarra(nombreDeRuta: string | undefined): boolean {
  return nombreDeRuta !== undefined && CON_BARRA_PROPIA.includes(nombreDeRuta);
}
