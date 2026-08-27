import type { Post } from '@/types';

/**
 * Las dos reglas de las listas de guardados: en que estado esta la lista y que
 * se lee en la fila de un audio.
 *
 * Viven aparte de la vista, y sin React, porque las comparten dos pantallas
 * —«Guardados» y la pestaña «Mis Audios» de la biblioteca— y porque son una
 * decision, no un dibujo: probarlas aqui es probarlas una vez.
 */

export type EstadoDeGuardados = 'loading' | 'content' | 'error' | 'empty';

/**
 * En que estado esta una lista pedida al servidor.
 *
 * `null` es «todavia no ha contestado»; la lista vacia solo significa «no
 * tienes nada» cuando NO hubo fallo. La distincion no es cosmetica: un corte
 * de red anunciado como «no tienes nada guardado» hace creer que se ha perdido
 * algo, y ademas esconde el boton de reintentar.
 *
 * Tener contenido gana al fallo a proposito: si ya hay filas en pantalla, un
 * fallo al pedir la pagina siguiente no puede borrarlas.
 */
export function estadoDeGuardados(
  items: readonly unknown[] | null,
  fallo: string | null,
): EstadoDeGuardados {
  if (items === null) return 'loading';
  if (items.length > 0) return 'content';
  return fallo ? 'error' : 'empty';
}

/** Lo que se pinta de un audio guardado en la lista. */
export type FilaDeAudio = {
  titulo: string;
  /** Quien lo publico y cuanto dura, cuando se sabe. Puede quedar vacio. */
  detalle: string;
  /**
   * Si se puede sonar aqui mismo. Sin URL firmada no hay nada que reproducir
   * (la firma caduca), asi que quien llama manda la fila al detalle en vez de
   * ensenar un boton de play que no haria nada.
   */
  reproducible: boolean;
};

export function filaDeAudio(
  post: Pick<Post, 'body' | 'author' | 'mediaUrl' | 'mediaDurationS'>,
): FilaDeAudio {
  // Un audio no tiene titulo propio: su nombre es el texto de la publicacion,
  // igual que en la lista de episodios del podcast. Solo la PRIMERA linea, que
  // un cuerpo de tres parrafos no cabe en una fila.
  const primeraLinea = (post.body ?? '').split('\n').map((l) => l.trim()).find(Boolean);
  const autor = (post.author ?? '').trim();
  const titulo = primeraLinea ?? (autor ? `Audio de ${autor}` : 'Audio');

  const partes = [autor, duracionCorta(post.mediaDurationS)].filter(Boolean);
  return { titulo, detalle: partes.join(' · '), reproducible: !!post.mediaUrl };
}

/**
 * Duracion en `m:ss`, la misma forma que marca el reproductor. Vacia si no se
 * sabe: inventar «0:00» diria que el audio esta vacio.
 */
function duracionCorta(segundos: number | undefined): string {
  if (!segundos || !Number.isFinite(segundos) || segundos <= 0) return '';
  const enteros = Math.floor(segundos);
  const minutos = Math.floor(enteros / 60);
  const resto = (enteros % 60).toString().padStart(2, '0');
  return `${minutos}:${resto}`;
}
