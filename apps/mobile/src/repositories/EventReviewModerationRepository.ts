import { cadenaDeFiltros } from '@/lib/moderacionDeResenas';
import { apiRequest, API_V1 } from '@/services/api';

/**
 * La moderación de reseñas de evento, por HTTP y solo por HTTP.
 *
 * SEPARADO DEL REPOSITORIO DE LECTURA, igual que el de posventa se separó del
 * del comprador: aquí viven las dos rutas que solo ve moderación y la única que
 * cambia el estado de una reseña. En el repositorio público no hay ni un método
 * que esconda nada, así que no puede colarse uno en la pantalla de quien lee.
 *
 * **NO EXISTE UN MÉTODO QUE BORRE.** Ni aquí ni en el servidor: la única ruta
 * que cambia una reseña es `POST /events/reviews/{id}/moderate`, y lo único que
 * acepta es `hide: true` o `hide: false`. Esconder deja el texto, la puntuación
 * y el autor intactos en la base, y `restaurar` los devuelve tal cual. Añadir
 * aquí un `borrar` sería inventarse una ruta y, peor, prometer algo
 * irreversible que nadie ha decidido.
 *
 * NI EL AUTOR NI LA PUNTUACIÓN VIAJAN. El cuerpo que se manda tiene dos
 * campos, `hide` y `reason`, y ningún método de este fichero acepta un `overall`
 * ni un `author_id`: no hay forma de editar una reseña desde moderación aunque
 * alguien lo intente desde la pantalla.
 *
 * SIN MOCKS Y SIN SUPABASE. Todo pasa por `apiRequest`, que es quien pone la
 * sesión y traduce los errores a `ApiError` con su `status` y su `code`.
 */

/** Una reseña vista por moderación: con su estado y su motivo. */
export type ResenaParaModerar = {
  id: string;
  event_id: string;
  /** Referencia interna de quien escribió. NO es un nombre ni un perfil. */
  author_id: string;
  /** De 1 a 5. Se lee; moderar no la cambia nunca. */
  overall: number;
  comment: string | null;
  /** `visible` o `hidden`. La base admite también `draft`. */
  status: string;
  /** Por qué se escondió. `null` mientras está visible. */
  moderation_reason: string | null;
  /** Quién la escondió, como referencia interna. `null` si está visible. */
  moderated_by: string | null;
  moderated_at: string | null;
  created_at: string;
};

/**
 * Un paso del historial. SOLO SE AÑADE: no hay método que lo edite.
 *
 * LA ACCIÓN ES EL DESTINO: no viene un verbo, viene dónde quedó la reseña.
 * Llegar a `hidden` es haberla ocultado; llegar a `visible`, restaurarla.
 */
export type PasoDeModeracion = {
  /** De dónde venía. `null` en el primer paso. */
  from_status: string | null;
  /** Dónde quedó: `hidden` o `visible`. Esto ES la acción. */
  to_status: string;
  reason: string | null;
  actor_id: string | null;
  created_at: string;
};

export const EventReviewModerationRepository = {
  /**
   * Las visibles Y LAS ESCONDIDAS, con filtro de evento y de estado.
   *
   * Sin las escondidas restaurar sería imposible y nadie podría comprobar qué
   * se escondió ni por qué. El servidor NO manda cursor: lo que vuelve es «las
   * más recientes hasta este tope», y la pantalla dice cuál es el tope.
   */
  async lista(opciones?: {
    estado?: string | null;
    eventoId?: string | null;
    limite?: number;
  }): Promise<ResenaParaModerar[]> {
    return apiRequest<ResenaParaModerar[]>(
      `${API_V1}/admin/events/reviews?${cadenaDeFiltros(opciones)}`,
    );
  },

  /** Qué se hizo con esta reseña y por qué. Se lee; no se reescribe. */
  async historial(reviewId: string): Promise<PasoDeModeracion[]> {
    return apiRequest<PasoDeModeracion[]>(
      `${API_V1}/admin/events/reviews/${reviewId}/moderation`,
    );
  },

  /**
   * La esconde. **NO LA BORRA**: el texto, la nota y el autor siguen enteros.
   *
   * El motivo es obligatorio en la firma porque es obligatorio en la práctica:
   * el servidor acepta `null`, y una reseña escondida que nadie puede explicar
   * es exactamente lo que no se quiere.
   */
  async ocultar(reviewId: string, motivo: string): Promise<ResenaParaModerar> {
    return apiRequest<ResenaParaModerar>(
      `${API_V1}/events/reviews/${reviewId}/moderate`,
      { method: 'POST', body: JSON.stringify({ hide: true, reason: motivo }) },
    );
  },

  /** La vuelve a mostrar. El motivo es opcional: solo viaja si se escribió. */
  async restaurar(
    reviewId: string,
    motivo?: string | null,
  ): Promise<ResenaParaModerar> {
    return apiRequest<ResenaParaModerar>(
      `${API_V1}/events/reviews/${reviewId}/moderate`,
      {
        method: 'POST',
        body: JSON.stringify({ hide: false, reason: motivo ?? null }),
      },
    );
  },
};
