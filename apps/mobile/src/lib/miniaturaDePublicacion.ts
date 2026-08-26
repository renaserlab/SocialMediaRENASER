import type { Post } from '@/types';

/**
 * Que pintar en la celda de una cuadricula (perfil, guardados, colecciones).
 *
 * Vive aparte y sin depender de React por dos motivos.
 *
 * EL PRIMERO: que la regla sea UNA. La cuadricula la pinta `ProfileGallery` y
 * la precarga la dispara `cachePerfil` al tocar un perfil. Si cada una decide
 * por su cuenta que imagen corresponde, la precarga calienta un archivo y la
 * celda pide otro: se descarga dos veces y la celda sigue negra el mismo rato
 * que antes. Preguntando los dos aqui, no pueden separarse.
 *
 * EL SEGUNDO: la CLAVE DE CACHE. `expo-image` guarda cada imagen bajo la clave
 * que se le de, y por defecto esa clave es la URL. Las nuestras van firmadas y
 * la firma CAMBIA cada vez que se pide: sin clave propia, volver a un perfil
 * tras refirmar no encuentra nada en disco y se descarga la cuadricula entera
 * otra vez. La ruta en Storage (`mediaPath` / `posterPath`) no cambia nunca, y
 * por eso es ella la que manda.
 *
 * Y una regla que no se negocia: un VIDEO en una cuadricula es su poster. Solo
 * el poster. Nunca la URL del video, que ademas suele ser el derivado ligero
 * pero sigue siendo un video: montar un reproductor por celda dejaba la
 * cuadricula en negro y agotaba la memoria del telefono.
 */
export type Miniatura = {
  /** URL firmada, lista para descargar. */
  uri: string;
  /** Identidad estable en disco: la ruta en Storage, no la firma. */
  cacheKey?: string;
};

export function miniaturaDePublicacion(post: {
  mediaType?: Post['mediaType'];
  mediaUrl?: string;
  mediaPath?: string;
  posterUrl?: string;
  posterPath?: string;
}): Miniatura | null {
  if (post.mediaType === 'video') {
    // Sin poster no hay nada que pintar: quien llama enseña su marcador con el
    // simbolo de video. Caer al video seria descargar megas para una celda de
    // 120 pixeles, y en la cuadricula ni siquiera se reproduce.
    if (!post.posterUrl) return null;
    return { uri: post.posterUrl, cacheKey: post.posterPath };
  }

  if (post.mediaType === 'image') {
    // `mediaPath` ya es el derivado del feed cuando existe (lo elige el mapper);
    // el original solo queda para lo publicado antes del pipeline.
    if (post.mediaUrl) return { uri: post.mediaUrl, cacheKey: post.mediaPath };
    // Una imagen con poster es rara, pero si el backend lo genero, sirve.
    if (post.posterUrl) return { uri: post.posterUrl, cacheKey: post.posterPath };
    return null;
  }

  // Audio y publicaciones sin medio: la cuadricula no las muestra.
  return null;
}
