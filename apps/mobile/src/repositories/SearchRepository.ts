import { apiRequest, API_V1 } from '@/services/api';
import { LIMITE_POR_GRUPO, type Grupo, type RespuestaDeBusqueda } from '@/lib/busquedaProgresiva';

export type { Grupo, RespuestaDeBusqueda } from '@/lib/busquedaProgresiva';

type OpcionesDeBusqueda = {
  /**
   * Acota la respuesta a UN grupo. Es ademas lo unico que permite paginar: sin
   * el, el backend devuelve la primera pagina de los cinco y `salto` se ignora,
   * porque un `offset` que avanzara los cinco a la vez haria que pedir la
   * pagina 2 de publicaciones se saltara personas que nadie ha visto.
   */
  grupo?: Grupo;
  limite?: number;
  salto?: number;
  /** Para cancelar la peticion cuando ya no interesa la respuesta. */
  signal?: AbortSignal;
};

/**
 * La busqueda global: personas, publicaciones, etiquetas, cursos y eventos.
 *
 * LO QUE SUSTITUYE. La pantalla de buscar filtraba `state.posts` —las veinte
 * publicaciones que el telefono ya tenia descargadas, asi que una publicacion
 * de hace tres meses era inencontrable— y se bajaba el CATALOGO ENTERO de
 * cursos para filtrarlo con un `includes`. Las dos cosas las resuelve ahora la
 * base de datos, que es donde estan todas las filas.
 *
 * SIN SESION TAMBIEN BUSCA. El endpoint acepta el token pero no lo exige: sin
 * cuenta se busca en lo publico, igual que el muro se lee sin cuenta desde la
 * 0018. `apiRequest` manda la cabecera solo si hay token, asi que aqui no hay
 * nada que decidir.
 *
 * LA IDENTIDAD NO SE MANDA COMO PARAMETRO. El resultado depende de quien
 * pregunta —bloqueos, borradores propios—, y eso lo saca el backend del token.
 * Si alguna vez se anade aqui un `viewer_id`, sera para buscar «como si fuera
 * otra persona»: no se anade.
 */
export const SearchRepository = {
  async buscar(
    consulta: string,
    { grupo, limite = LIMITE_POR_GRUPO, salto = 0, signal }: OpcionesDeBusqueda = {},
  ): Promise<RespuestaDeBusqueda> {
    const q = consulta.trim();
    const partes = [`q=${encodeURIComponent(q)}`, `limit=${limite}`];
    if (grupo) {
      partes.push(`type=${grupo}`);
      // El backend ignora el salto sin `type`; no mandarlo evita que parezca
      // que hace algo cuando no lo hace.
      if (salto > 0) partes.push(`offset=${salto}`);
    }
    return apiRequest<RespuestaDeBusqueda>(`${API_V1}/search?${partes.join('&')}`, { signal });
  },
};
