import { apiRequest, API_V1 } from '@/services/api';

/**
 * Los apuntes privados de una leccion, contra `/api/v1/learning`.
 *
 * QUE NO ES ESTO. No son comentarios ni valoraciones: no se publican, no se
 * moderan y no hay ninguna ruta —ni aqui ni en el servidor— para leer los de
 * otra persona. Ni el autor del curso, ni moderacion. Por eso ninguna funcion
 * de este fichero acepta un identificador de usuario: quien pregunta sale del
 * token y el servidor filtra por el.
 *
 * SIN LA MIGRACION 0057 APLICADA todas estas llamadas responden 503 con
 * `lesson_notes_not_available`. No se traga aqui: quien pinta necesita
 * distinguirlo para no ensenar la pestana, y eso lo resuelve `pestanaNoMontada`
 * en `lib/notasDeLeccion.ts`.
 */

const LEARNING = `${API_V1}/learning`;

/** Un apunte, ya en el idioma de la aplicacion. */
export type NotaDeLeccion = {
  id: string;
  leccionId: string;
  cursoId: string;
  texto: string;
  /** El minuto del video. `null` cuando no habia posicion real. */
  posicionSegundos: number | null;
  /** La version del curso que se estudiaba. `null` si no habia publicada. */
  versionDelCurso: number | null;
  creadaEnIso: string;
  actualizadaEnIso: string;
};

type NotaDto = {
  id: string;
  lesson_id: string;
  course_id: string;
  body: string;
  position_seconds?: number | null;
  course_version?: number | null;
  created_at: string;
  updated_at: string;
};

function aNota(dto: NotaDto): NotaDeLeccion {
  return {
    id: dto.id,
    leccionId: dto.lesson_id,
    cursoId: dto.course_id,
    texto: dto.body,
    // `?? null` y no `?? 0`: cero diria «al principio del video».
    posicionSegundos: dto.position_seconds ?? null,
    versionDelCurso: dto.course_version ?? null,
    creadaEnIso: dto.created_at,
    actualizadaEnIso: dto.updated_at,
  };
}

export const LessonNoteRepository = {
  /** Mis apuntes de esta leccion, del mas reciente al mas viejo. */
  async listar(leccionId: string): Promise<NotaDeLeccion[]> {
    const dtos = await apiRequest<NotaDto[]>(
      `${LEARNING}/lessons/${leccionId}/notes`,
    );
    return (dtos ?? []).map(aNota);
  },

  /**
   * Apuntar algo.
   *
   * `clave` viaja como `Idempotency-Key`: con ella, dos toques seguidos NO
   * crean dos notas —el servidor deriva el id de la clave y la segunda choca
   * contra la clave primaria—. Es la unica proteccion que sobrevive a que la
   * primera respuesta se pierda por el camino.
   */
  async crear(
    leccionId: string,
    datos: { texto: string; posicionSegundos: number | null; clave: string },
  ): Promise<NotaDeLeccion> {
    const dto = await apiRequest<NotaDto>(`${LEARNING}/lessons/${leccionId}/notes`, {
      method: 'POST',
      headers: { 'Idempotency-Key': datos.clave },
      body: JSON.stringify({
        body: datos.texto,
        position_seconds: datos.posicionSegundos,
      }),
    });
    return aNota(dto);
  },

  /** Corregir un apunte propio. Solo se manda lo que cambia. */
  async editar(notaId: string, texto: string): Promise<NotaDeLeccion> {
    const dto = await apiRequest<NotaDto>(`${LEARNING}/notes/${notaId}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: texto }),
    });
    return aNota(dto);
  },

  /** Borrarlo. Es suyo: se borra de verdad, no se oculta. */
  async retirar(notaId: string): Promise<void> {
    await apiRequest<void>(`${LEARNING}/notes/${notaId}`, { method: 'DELETE' });
  },
};
