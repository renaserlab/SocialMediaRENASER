import { apiRequest, API_V1, ApiError } from '@/services/api';

/**
 * Etiquetas de conversación: el CRM ligero de la bandeja (migración 0045).
 *
 * QUÉ ES. Que cada persona ordene su bandeja con sus propias categorías
 * —«Seguimiento», «Interesado», «Alumno»— y pueda filtrar por ellas desde la
 * fila de chips de arriba. Nada más: no hay embudo de ventas, ni importes, ni
 * puntuación de contactos.
 *
 * -----------------------------------------------------------------------------
 * SON PRIVADAS, Y ESO SE DECIDE EN EL SERVIDOR
 * -----------------------------------------------------------------------------
 * La etiqueta que pongo a mi conversación con alguien, esa persona NO la ve
 * jamás. Aquí no hay nada que filtrar ni que esconder: el backend sólo devuelve
 * las de quien pregunta, así que estos métodos no pueden traer una ajena ni por
 * error. Es a propósito — esconder algo en la pantalla no lo hace privado: lo
 * que sale del servidor acaba viéndose antes o después, en otro cliente o en
 * una respuesta cruda.
 *
 * -----------------------------------------------------------------------------
 * POR QUÉ NO SE GUARDAN EN EL TELÉFONO
 * -----------------------------------------------------------------------------
 * Nada de `AsyncStorage`. Una etiqueta es trabajo de organización, no una
 * preferencia de pantalla: tiene que seguir ahí al reinstalar la aplicación, al
 * abrirla en otro teléfono y al entrar desde la web. Guardarla en el disco de
 * un dispositivo sería perderla el día que ese dispositivo se cambie, que es
 * justo el día en que más se echa de menos.
 *
 * -----------------------------------------------------------------------------
 * SIN LA MIGRACIÓN 0045 NO SE ROMPE NADA
 * -----------------------------------------------------------------------------
 * El backend responde `[]` al listar y 503 `conversation_labels_not_available`
 * al escribir. `cargarEtiquetas` traduce eso a `disponible: false` y la interfaz
 * NO OFRECE la función —ni chips, ni botón— en vez de dejar un botón muerto.
 *
 * -----------------------------------------------------------------------------
 * QUÉ SE HA COMPROBADO CONTRA EL ESQUEMA DE VERDAD
 * -----------------------------------------------------------------------------
 * Las siete llamadas de abajo son EXACTAMENTE las siete rutas que declara
 * `apps/api/app/modules/messaging/etiquetas.py`, y los campos que se leen
 * (`id`, `nombre`, `conversaciones`) son los de sus `EtiquetaBreve` /
 * `EtiquetaRead`. Nada de esto es nuevo ni ha hecho falta cambiarlo: la
 * asignación es idempotente por la clave primaria compuesta de la 0045 (de ahí
 * el `PUT`), retirarla dos veces tampoco es un error, y el filtro por etiqueta
 * viaja como `label_id` en la consulta del listado (`lib/bandeja.ts`), que es
 * donde tiene que estar para que la paginación siga contando filas de verdad.
 * Lo único que se ha tocado en esta ronda es el DESCUBRIMIENTO de la función,
 * en `ChipsDeEtiquetas`. Y NO existen etiquetas de mensajes sueltos: una
 * etiqueta se pone a la conversación entera, que es lo que guarda
 * `conversation_label_assignments`.
 */

/** Una etiqueta con cuántas conversaciones lleva (las de quien pregunta). */
export type Etiqueta = {
  id: string;
  nombre: string;
  conversaciones: number;
};

/** Lo mínimo para pintar un chip. Es lo que devuelve el detalle de un chat. */
export type EtiquetaBreve = {
  id: string;
  nombre: string;
};

/**
 * Lo que responde el servidor mientras la 0045 espera aprobación.
 *
 * Se compara por CÓDIGO y no por el estado 503 a secas: un 503 puede venir
 * también de un despliegue a medias o de un proxy, y en ese caso lo que toca es
 * avisar de que algo va mal, no esconder una función que sí existe.
 */
export const ETIQUETAS_NO_DISPONIBLES = 'conversation_labels_not_available';

/** El tope del servidor. Se repite aquí sólo para no dejar escribir de más. */
export const MAX_NOMBRE_DE_ETIQUETA = 40;

/** Si un error es «esto todavía no está puesto» y no «esto se ha roto». */
export function esFuncionNoDisponible(error: unknown): boolean {
  return error instanceof ApiError && error.code === ETIQUETAS_NO_DISPONIBLES;
}

export const EtiquetasRepository = {
  /**
   * Todas mis etiquetas, con su cuenta.
   *
   * SIN PAGINAR, y no es un descuido: el servidor limita cuántas puede tener
   * una persona, así que esta respuesta ES la lista completa. Paginar una fila
   * horizontal de filtros sería además una función que nadie sabría usar.
   */
  async listar(): Promise<Etiqueta[]> {
    return apiRequest<Etiqueta[]>(`${API_V1}/conversations/labels`);
  },

  async crear(nombre: string): Promise<Etiqueta> {
    return apiRequest<Etiqueta>(`${API_V1}/conversations/labels`, {
      method: 'POST',
      body: JSON.stringify({ nombre }),
    });
  },

  /**
   * Cambia el nombre. NO mueve las conversaciones de sitio: lo que cambia es la
   * palabra, no la clasificación.
   */
  async renombrar(labelId: string, nombre: string): Promise<Etiqueta> {
    return apiRequest<Etiqueta>(`${API_V1}/conversations/labels/${labelId}`, {
      method: 'PATCH',
      body: JSON.stringify({ nombre }),
    });
  },

  /**
   * Borra la etiqueta. NO BORRA NINGUNA CONVERSACIÓN NI NINGÚN MENSAJE: sólo
   * deja de estar puesta donde estaba. Es lo que más miedo da al pulsarlo, así
   * que el gestor lo dice antes de hacerlo.
   *
   * Es idempetente en el servidor: borrar dos veces responde igual.
   */
  async borrar(labelId: string): Promise<void> {
    await apiRequest<void>(`${API_V1}/conversations/labels/${labelId}`, {
      method: 'DELETE',
    });
  },

  /** MIS etiquetas en esa conversación. Las del otro lado no existen aquí. */
  async deLaConversacion(conversationId: string): Promise<EtiquetaBreve[]> {
    return apiRequest<EtiquetaBreve[]>(
      `${API_V1}/conversations/${conversationId}/labels`,
    );
  },

  /**
   * Pone una etiqueta a una conversación.
   *
   * `PUT` porque es IDEMPOTENTE: pulsarlo dos veces deja el mismo estado, y lo
   * garantiza la clave primaria de la tabla, no una comprobación previa. Por
   * eso reintentar esta llamada tras una red lenta es seguro.
   */
  async asignar(conversationId: string, labelId: string): Promise<void> {
    await apiRequest<void>(
      `${API_V1}/conversations/${conversationId}/labels/${labelId}`,
      { method: 'PUT' },
    );
  },

  /** La quita. Quitar lo que ya no estaba tampoco es un error. */
  async quitar(conversationId: string, labelId: string): Promise<void> {
    await apiRequest<void>(
      `${API_V1}/conversations/${conversationId}/labels/${labelId}`,
      { method: 'DELETE' },
    );
  },
};

/** Lo que necesita la bandeja para decidir si ofrece la función y con qué. */
export type EstadoDeEtiquetas = {
  /**
   * `false` mientras la 0045 no esté aplicada. La pantalla no pinta los chips
   * ni el botón de gestionar: nunca un botón muerto.
   *
   * También queda en `false` si la lista falla por cualquier otro motivo, y eso
   * es deliberado: la bandeja tiene que abrirse aunque el CRM no conteste. Unas
   * etiquetas que no cargan no pueden dejar a nadie sin sus mensajes.
   */
  disponible: boolean;
  etiquetas: Etiqueta[];
};

/**
 * Carga las etiquetas SIN PODER FALLAR.
 *
 * Es lo que monta la bandeja, y por eso no lanza: la lista de conversaciones y
 * la de etiquetas son dos peticiones distintas, y que la segunda se caiga no
 * puede impedir que se vean los mensajes. Lo peor que puede pasar es que la
 * fila de chips no salga hoy.
 *
 * Se distingue el 503 de la migración de cualquier otro fallo sólo para
 * registrarlo: el resultado para la pantalla es el mismo —no ofrecer la
 * función—, pero en los registros conviene poder diferenciar «todavía no está
 * puesto» de «algo se ha roto».
 */
export async function cargarEtiquetas(): Promise<EstadoDeEtiquetas> {
  try {
    return { disponible: true, etiquetas: await EtiquetasRepository.listar() };
  } catch (error) {
    if (!esFuncionNoDisponible(error)) {
      console.warn('[etiquetas] no se pudieron cargar', error);
    }
    return { disponible: false, etiquetas: [] };
  }
}
