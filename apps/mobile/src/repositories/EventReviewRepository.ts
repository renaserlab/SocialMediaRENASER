import { apiRequest, API_V1 } from '@/services/api';

/**
 * Las reseñas verificadas de un evento, contra `/api/v1/events`.
 *
 * QUÉ NO ES ESTO. No sustituye a `CourseReviewRepository` —que puntúa un
 * curso— ni a `ReviewRepository` —que son reseñas de una persona sobre otra—.
 * Aquí se opina de un EVENTO al que se asistió, y una reseña existe solo si
 * hubo check-in: son tres dominios con tres tablas distintas.
 *
 * LO QUE ESTE FICHERO NO DECIDE: quién puede opinar, si la asistencia está
 * verificada y si responder en público está habilitado. Las tres las decide el
 * servidor (`events/resenas.py`) mirando el check-in, el evento y la política
 * publicada. El teléfono no ve los check-ins de nadie, así que cualquier
 * deducción de aquí sería una invención.
 *
 * SIN MODERACIÓN. `POST /events/reviews/{id}/moderate` existe y NO tiene método
 * aquí: esconder una opinión es de administración, y un repositorio que expone
 * lo que la aplicación no debe llamar es una invitación a llamarlo.
 *
 * LO PÚBLICO SE PIDE SIN SESIÓN. El resumen y la lista se leen sin cuenta, como
 * la ficha del evento; `mine` y `can-review` sí la necesitan, y quien mire sin
 * sesión simplemente no los pide.
 */

const EVENTOS = `${API_V1}/events`;

/** La respuesta del organizador, tal como se lee debajo de la reseña. */
export type RespuestaAResena = {
  id: string;
  author_id: string;
  body: string;
  created_at: string;
};

/** Una reseña publicada. SIN la entrada ni el check-in que la respaldan. */
export type ResenaDeEvento = {
  id: string;
  event_id: string;
  author_id: string;
  /** Del 1 al 5. Responde a «¿entregó lo que anunció?». */
  overall: number;
  /** Los cinco ejes, cada uno opcional por separado. `null` = sin puntuar. */
  content: number | null;
  organization: number | null;
  venue: number | null;
  safety: number | null;
  value: number | null;
  /** `null` = no contestó a la pregunta. NO es un «no». */
  recommends: boolean | null;
  comment: string | null;
  /** Siempre `true`: una reseña existe porque hubo check-in. */
  asistencia_verificada: boolean;
  /** UNA como mucho, y solo si está visible. */
  respuesta: RespuestaAResena | null;
  /** `visible`, `hidden` o `draft`. SOLO viaja en la reseña propia. */
  status: string | null;
  created_at: string;
};

/**
 * El resumen de la ficha.
 *
 * `promedio` es `null` cuando no hay reseñas: **no es cero**. Lo mismo
 * `recomiendan_bps` —`null` = nadie contestó— y cada entrada de `por_eje`.
 */
export type ResumenDeEvento = {
  total: number;
  promedio: number | null;
  /** `{ "1": n, … }`. Los cajones sin nadie pueden no venir. */
  histograma: Record<string, number>;
  /** En puntos básicos. `null` NO es 0 %. */
  recomiendan_bps: number | null;
  por_eje: Record<string, number | null>;
};

/** Si esta persona puede valorar, y por qué no. El motivo es un CÓDIGO. */
export type PermisoParaResenar = {
  puede: boolean;
  motivo: string;
};

/** Lo que viaja al crear o al editar. Lo construye `cuerpoDeResena`. */
export type CuerpoDeResenaHttp = {
  overall: number;
  ejes?: Record<string, number>;
  recommends: boolean | null;
  comment: string;
};

/** Lo que contesta el servidor al responder. La respuesta entera no vuelve. */
export type RespuestaCreada = {
  id: string;
  status: string;
};

export const EventReviewRepository = {
  /** Promedio, histograma, recomendación y ejes. Se lee sin sesión. */
  async resumen(eventId: string): Promise<ResumenDeEvento> {
    return apiRequest<ResumenDeEvento>(`${EVENTOS}/${eventId}/reviews/summary`, {
      auth: false,
    });
  },

  /**
   * Una página de reseñas, de la más reciente a la más antigua.
   *
   * El cursor lo construye `cursorDeLaPagina`: es `created_at|id` y el servidor
   * lo valida entero, así que no se inventa aquí.
   */
  async listar(
    eventId: string,
    limite: number,
    cursor?: string | null,
  ): Promise<ResenaDeEvento[]> {
    const q = new URLSearchParams({ limit: String(limite) });
    if (cursor) q.set('cursor', cursor);
    const filas = await apiRequest<ResenaDeEvento[]>(
      `${EVENTOS}/${eventId}/reviews?${q.toString()}`,
      { auth: false },
    );
    return filas ?? [];
  },

  /**
   * La reseña propia de este evento, o `null` si no hay ninguna.
   *
   * Incluye la ESCONDIDA por moderación, con su `status`: su autora tiene que
   * poder ver lo que escribió.
   */
  async mia(eventId: string): Promise<ResenaDeEvento | null> {
    return apiRequest<ResenaDeEvento | null>(`${EVENTOS}/${eventId}/reviews/mine`);
  },

  /** Si se puede valorar. NO ESCRIBE NADA y no promete nada. */
  async permiso(eventId: string): Promise<PermisoParaResenar> {
    return apiRequest<PermisoParaResenar>(`${EVENTOS}/${eventId}/reviews/can-review`);
  },

  /** Publica la reseña. El servidor exige asistencia verificada y política. */
  async crear(eventId: string, cuerpo: CuerpoDeResenaHttp): Promise<ResenaDeEvento> {
    return apiRequest<ResenaDeEvento>(`${EVENTOS}/${eventId}/reviews`, {
      method: 'POST',
      body: JSON.stringify(cuerpo),
    });
  },

  /** Cambia la propia. Nadie edita la de otra persona, ni moderación. */
  async editar(
    resenaId: string,
    cuerpo: CuerpoDeResenaHttp,
  ): Promise<ResenaDeEvento> {
    return apiRequest<ResenaDeEvento>(`${EVENTOS}/reviews/${resenaId}`, {
      method: 'PATCH',
      body: JSON.stringify(cuerpo),
    });
  },

  /**
   * La respuesta del organizador.
   *
   * NACE APAGADA: sin la política publicada el servidor contesta
   * `event_reply_not_configured`, y eso no es un error genérico sino un «esto
   * todavía no está habilitado» que la pantalla dice con su propio texto.
   */
  async responder(resenaId: string, texto: string): Promise<RespuestaCreada> {
    return apiRequest<RespuestaCreada>(`${EVENTOS}/reviews/${resenaId}/reply`, {
      method: 'POST',
      body: JSON.stringify({ body: texto }),
    });
  },
};
