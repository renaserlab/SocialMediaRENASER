import { apiRequest, API_V1 } from '@/services/api';
import { resolveMediaUrls } from '@/repositories/PostRepository';
import { toPost, type PostDto } from '@/mappers/postMapper';
import type { Post } from '@/types';

/** Una etiqueta y cuántas publicaciones tiene DE VERDAD. */
export type HashtagDto = {
  /** Forma normalizada, sin almohadilla. Es la que va en la URL. */
  tag: string;
  /** Como se escribió la primera vez. Es la que se pinta. */
  display_tag: string;
  posts_count: number;
};

/**
 * Etiquetas sociales: buscarlas, verlas y leer lo publicado con ellas.
 *
 * TODO ESTO FUNCIONA SIN LA MIGRACIÓN 0031. El backend responde vacío mientras
 * las tablas no existan —no un error— así que la pantalla enseña «todavía no
 * hay publicaciones» y nadie ve un fallo. Es lo que permite desplegar el móvil
 * antes de que un humano apruebe la migración.
 */
export const HashtagRepository = {
  /**
   * La etiqueta y su cuenta real de publicaciones.
   *
   * Una etiqueta que nadie usó NO es un error: responde con cero. Por eso esto
   * no distingue «no existe» de «existe y está vacía»; para la pantalla son la
   * misma cosa y decirlo de dos formas distintas no ayudaría a nadie.
   */
  async detalle(nombre: string): Promise<HashtagDto> {
    return apiRequest<HashtagDto>(
      `${API_V1}/hashtags/${encodeURIComponent(nombre)}`,
    );
  },

  /**
   * Las publicaciones de una etiqueta, paginadas.
   *
   * `withMediaUrls` en dos fases, igual que el feed: primero se pinta el texto
   * y se reservan los huecos con la metadata, y las imágenes se completan
   * después. Con la caché de firmas eso suele resolverse sin tocar la red.
   */
  async publicaciones(
    nombre: string,
    {
      limit = 20,
      offset = 0,
      withMediaUrls = true,
    }: { limit?: number; offset?: number; withMediaUrls?: boolean } = {},
    currentUserId?: string | null,
  ): Promise<Post[]> {
    const dtos = await apiRequest<PostDto[]>(
      `${API_V1}/hashtags/${encodeURIComponent(nombre)}/posts?limit=${limit}&offset=${offset}`,
    );
    const items = dtos.map((dto) => toPost(dto, currentUserId));
    return withMediaUrls ? resolveMediaUrls(items) : items;
  },

  /**
   * Etiquetas que empiezan por el término, las más usadas primero.
   *
   * POR PREFIJO Y NO POR «CONTIENE»: quien escribe «pyt» busca «#python», no
   * «#micropython». Lo decide el backend, que es el único que puede usar el
   * índice para eso.
   */
  async buscar(termino: string, limite = 10): Promise<HashtagDto[]> {
    const limpio = termino.trim();
    if (limpio.length < 1) return [];
    return apiRequest<HashtagDto[]>(
      `${API_V1}/hashtags/search?q=${encodeURIComponent(limpio)}&limit=${limite}`,
    );
  },
};
