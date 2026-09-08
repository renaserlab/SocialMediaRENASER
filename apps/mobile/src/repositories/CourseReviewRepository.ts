import { apiRequest, API_V1 } from '@/services/api';
import {
  normalizaResumen,
  type ResumenDeValoraciones,
  type ResumenDto,
} from '@/lib/valoracionesDeCurso';

/**
 * Valoraciones DE UN CURSO, contra `/api/v1/catalog/courses/{id}/reviews`.
 *
 * QUE NO ES ESTO. No sustituye a `ReviewRepository`, que son las reseñas de
 * una PERSONA sobre otra y viven en `/api/v1/reviews`. Aqui se puntua un curso
 * del 1 al 5, solo se puede si se compro y sigue habiendo acceso, y hay una
 * por persona y curso. Son dos dominios distintos con dos tablas distintas;
 * mezclarlos habria significado que un cambio en las reglas de una moviera la
 * otra.
 *
 * LO QUE ESTE FICHERO NO DECIDE: quien puede valorar, ni si una compra esta
 * verificada. Las dos cosas las calcula el servidor mirando las compras y las
 * devoluciones (`catalog/valoraciones.py`). El telefono no ve las ordenes de
 * nadie, asi que cualquier deduccion de aqui seria una invencion.
 *
 * SIN LA MIGRACION 0056 APLICADA todas estas llamadas responden 503 con
 * `course_reviews_not_available`. No se traga el error aqui: quien pinta
 * necesita distinguirlo para no ensenar la seccion, y eso lo resuelve
 * `seccionNoMontada` en `lib/valoracionesDeCurso.ts`.
 */

const CURSOS = `${API_V1}/catalog/courses`;

/** Una valoracion, ya en el idioma de la aplicacion. */
export type ValoracionDeCurso = {
  id: string;
  cursoId: string;
  /** Del 1 al 5. */
  puntuacion: number;
  comentario: string | null;
  creadaEnIso: string;
  actualizadaEnIso: string;
  autorId: string;
  /** Puede llegar vacio: el servidor manda '' cuando no hay perfil. */
  autorNombre: string;
  autorUsuario: string;
  /**
   * Compro Y su acceso sigue vivo. Lo decide el SERVIDOR en cada lectura, asi
   * que una devolucion posterior apaga el sello sin borrar la valoracion.
   */
  compraVerificada: boolean;
  /** Si la escribio quien esta mirando. Solo asi se puede editar o retirar. */
  esMia: boolean;
};

type ValoracionDto = {
  id: string;
  course_id: string;
  rating: number;
  comment?: string | null;
  created_at: string;
  updated_at: string;
  author_id: string;
  author_name?: string | null;
  author_username?: string | null;
  verified_purchase?: boolean | null;
  is_mine?: boolean | null;
};

function aValoracion(dto: ValoracionDto): ValoracionDeCurso {
  return {
    id: dto.id,
    cursoId: dto.course_id,
    puntuacion: dto.rating,
    comentario: dto.comment ?? null,
    creadaEnIso: dto.created_at,
    actualizadaEnIso: dto.updated_at,
    autorId: dto.author_id,
    autorNombre: dto.author_name ?? '',
    autorUsuario: dto.author_username ?? '',
    // `=== true` y no `?? false`: un campo ausente NO es un sello de compra.
    compraVerificada: dto.verified_purchase === true,
    esMia: dto.is_mine === true,
  };
}

/** Lo que se manda al valorar o al editar. El comentario es opcional. */
export type DatosDeValoracion = {
  puntuacion: number;
  /** `null` deja la valoracion sin comentario, que es como se borra. */
  comentario: string | null;
};

function cuerpo(datos: DatosDeValoracion): string {
  return JSON.stringify({ rating: datos.puntuacion, comment: datos.comentario });
}

export const CourseReviewRepository = {
  /** Media, total y distribucion. Se lee sin sesion. */
  async resumen(cursoId: string): Promise<ResumenDeValoraciones> {
    const dto = await apiRequest<ResumenDto>(`${CURSOS}/${cursoId}/reviews/summary`);
    return normalizaResumen(dto);
  },

  /** Una pagina de valoraciones, de la mas reciente a la mas antigua. */
  async listar(
    cursoId: string,
    { limite, desde }: { limite: number; desde: number },
  ): Promise<ValoracionDeCurso[]> {
    const dtos = await apiRequest<ValoracionDto[]>(
      `${CURSOS}/${cursoId}/reviews?limit=${limite}&offset=${desde}`,
    );
    return (dtos ?? []).map(aValoracion);
  },

  /**
   * Valorar por primera vez.
   *
   * Quien firma NO viaja en el cuerpo: sale del token. Si ya hay una, el
   * servidor responde 409 `course_review_exists` —lo sostiene un indice unico,
   * no un `if`— y lo que toca entonces es editar, no reintentar.
   */
  async crear(cursoId: string, datos: DatosDeValoracion): Promise<ValoracionDeCurso> {
    const dto = await apiRequest<ValoracionDto>(`${CURSOS}/${cursoId}/reviews`, {
      method: 'POST',
      body: cuerpo(datos),
    });
    return aValoracion(dto);
  },

  /** Cambiar la propia. Nadie edita la de otro, ni siquiera administracion. */
  async editar(
    cursoId: string,
    valoracionId: string,
    datos: DatosDeValoracion,
  ): Promise<ValoracionDeCurso> {
    const dto = await apiRequest<ValoracionDto>(
      `${CURSOS}/${cursoId}/reviews/${valoracionId}`,
      { method: 'PATCH', body: cuerpo(datos) },
    );
    return aValoracion(dto);
  },

  /** Retirar la propia. */
  async retirar(cursoId: string, valoracionId: string): Promise<void> {
    await apiRequest<void>(`${CURSOS}/${cursoId}/reviews/${valoracionId}`, {
      method: 'DELETE',
    });
  },
};
