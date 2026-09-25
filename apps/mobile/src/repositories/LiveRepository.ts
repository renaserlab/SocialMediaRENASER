import {
  clasificarFalloDeCredencial,
  type FalloDeCredencial,
} from '@/live/maquinaDeDirecto';
import {
  hayVideoEnLaCredencial,
  leerCredencial,
  type CredencialDeVideo,
} from '@/live/salaDeVideo';
import { ApiError, apiRequest, API_V1 } from '@/services/api';
import { profileImageUrl } from '@/services/storage';

/**
 * Las emisiones en vivo a traves del backend FastAPI (`/api/v1/live`).
 *
 * Sustituye al contrato de relleno que habia en `feed/transmisiones.ts`, que
 * devolvia siempre la lista vacia porque no existia dominio de directo. Ahora
 * si existe: sala, chat y reacciones estan en la base y tienen endpoints.
 *
 * LO QUE SIGUE SIN EXISTIR ES EL VIDEO. La respuesta trae `playback_available`
 * justamente para eso: para que la interfaz pueda decir la verdad —«todavia no
 * hay video, el chat si funciona»— en vez de dejar un reproductor girando
 * contra una URL que nadie va a servir. Ver `solicitarCredencial`.
 *
 * Los GET aceptan anonimo, pero se piden CON sesion igualmente (el `auth` por
 * defecto de `apiRequest`): sin la cabecera el servidor no puede calcular
 * `can_manage`, y quien emite entraria en su propia sala sin los controles.
 */

export type EstadoDeEmision = 'scheduled' | 'live' | 'ended' | 'cancelled';

/**
 * Las reacciones que acepta el servidor, en el orden en que se pintan.
 *
 * Es la lista cerrada del backend. Vive aqui —y no en la pantalla— porque el
 * canal de Broadcast recibe lo que mande CUALQUIER otro cliente, y `esReaccion`
 * es lo que impide que un payload inventado acabe contando como reaccion.
 */
export const REACCIONES = ['corazon', 'aplauso', 'fuego', 'asombro', 'risa'] as const;

export type TipoDeReaccion = (typeof REACCIONES)[number];

export type ConteoDeReacciones = Record<TipoDeReaccion, number>;

/** Todas a cero. Se escribe entera para que el tipo no dependa de un bucle. */
export function reaccionesVacias(): ConteoDeReacciones {
  return { corazon: 0, aplauso: 0, fuego: 0, asombro: 0, risa: 0 };
}

/** Si un texto cualquiera es una reaccion valida. */
export function esReaccion(valor: unknown): valor is TipoDeReaccion {
  return typeof valor === 'string' && (REACCIONES as readonly string[]).includes(valor);
}

/** Una emision, ya en el idioma de la aplicacion. */
export type Emision = {
  id: string;
  anfitrionId: string;
  anfitrionNombre: string;
  anfitrionUsuario: string | null;
  /** Ya firmada contra el bucket publico de avatares; undefined si no tiene. */
  anfitrionAvatarUrl?: string;
  titulo: string;
  descripcion: string | null;
  estado: EstadoDeEmision;
  /** ISO. Solo tiene sentido mientras esta `scheduled`. */
  programadaParaIso: string | null;
  empezoEnIso: string | null;
  terminoEnIso: string | null;
  /** Quien reparte el video. Hoy siempre null: no hay proveedor contratado. */
  proveedor: string | null;
  /**
   * Si hay video que reproducir. Lo decide el SERVIDOR y no se deduce del
   * estado: una emision puede estar `live` y no tener video, que es justo el
   * caso de hoy.
   */
  reproduccionDisponible: boolean;
  grabacionRuta: string | null;
  /** Maximo de espectadores a la vez que ha visto el servidor. */
  picoDeEspectadores: number;
  reacciones: ConteoDeReacciones;
  /** Si quien pregunta puede terminarla y moderar su chat. Lo dice el servidor. */
  puedeGestionar: boolean;
};

/** Un mensaje del chat de una emision. */
export type MensajeDeEmision = {
  id: string;
  emisionId: string;
  usuarioId: string;
  usuarioNombre: string;
  usuarioAvatarUrl?: string;
  cuerpo: string;
  creadoEnIso: string;
  /** Lo escondio la moderacion. La lista lo trae para poder no pintarlo. */
  oculto: boolean;
};

/** Lo que se manda al crear o editar la ficha de una emision. */
export type DatosDeEmision = {
  titulo?: string;
  descripcion?: string;
  /** ISO. Sin esto, `crear` la deja EN DIRECTO desde el primer momento. */
  programadaParaIso?: string;
};

type EmisionDto = {
  id: string;
  host_id: string;
  host_name: string;
  host_username: string | null;
  host_avatar_path: string | null;
  title: string;
  description: string | null;
  status: EstadoDeEmision;
  scheduled_for: string | null;
  started_at: string | null;
  ended_at: string | null;
  provider: string | null;
  playback_available: boolean;
  recording_path: string | null;
  viewer_peak: number;
  reactions: Record<string, number> | null;
  can_manage: boolean;
};

type MensajeDto = {
  id: string;
  session_id: string;
  user_id: string;
  user_name: string;
  user_avatar_path: string | null;
  body: string;
  created_at: string;
  hidden: boolean;
};

type ResumenDeReaccionesDto = {
  session_id: string;
  totals: Record<string, number> | null;
};

function aConteo(crudo: Record<string, number> | null | undefined): ConteoDeReacciones {
  const total = reaccionesVacias();
  if (!crudo) return total;
  for (const tipo of REACCIONES) {
    const valor = crudo[tipo];
    // Un contador que no es un numero se queda en cero: pintar «NaN» junto a un
    // corazon es peor que pintar un cero.
    if (typeof valor === 'number' && Number.isFinite(valor)) total[tipo] = valor;
  }
  return total;
}

function aEmision(dto: EmisionDto): Emision {
  return {
    id: dto.id,
    anfitrionId: dto.host_id,
    anfitrionNombre: dto.host_name,
    anfitrionUsuario: dto.host_username,
    anfitrionAvatarUrl: profileImageUrl(dto.host_avatar_path),
    titulo: dto.title,
    descripcion: dto.description,
    estado: dto.status,
    programadaParaIso: dto.scheduled_for,
    empezoEnIso: dto.started_at,
    terminoEnIso: dto.ended_at,
    proveedor: dto.provider,
    reproduccionDisponible: dto.playback_available,
    grabacionRuta: dto.recording_path,
    picoDeEspectadores: dto.viewer_peak ?? 0,
    reacciones: aConteo(dto.reactions),
    puedeGestionar: dto.can_manage,
  };
}

function aMensaje(dto: MensajeDto): MensajeDeEmision {
  return {
    id: dto.id,
    emisionId: dto.session_id,
    usuarioId: dto.user_id,
    usuarioNombre: dto.user_name,
    usuarioAvatarUrl: profileImageUrl(dto.user_avatar_path),
    cuerpo: dto.body,
    creadoEnIso: dto.created_at,
    oculto: dto.hidden,
  };
}

function cuerpoDeEmision(datos: DatosDeEmision): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (datos.titulo !== undefined) payload.title = datos.titulo;
  if (datos.descripcion !== undefined) payload.description = datos.descripcion;
  if (datos.programadaParaIso !== undefined) payload.scheduled_for = datos.programadaParaIso;
  return payload;
}

/** Atajo para los tres cambios de estado, que comparten forma exacta. */
function transicion(emisionId: string, accion: 'start' | 'end' | 'cancel'): Promise<Emision> {
  return apiRequest<EmisionDto>(`${API_V1}/live/sessions/${emisionId}/${accion}`, {
    method: 'POST',
  }).then(aEmision);
}

export const LiveRepository = {
  /**
   * Las emisiones visibles.
   *
   * Por defecto NO trae las terminadas: la pestana de Inicio pregunta «que hay
   * ahora», y una lista encabezada por directos de la semana pasada responde a
   * otra cosa.
   */
  async listar(
    { incluirTerminadas = false, limite = 20 }: { incluirTerminadas?: boolean; limite?: number } = {},
  ): Promise<Emision[]> {
    const dtos = await apiRequest<EmisionDto[]>(
      `${API_V1}/live/sessions?include_ended=${incluirTerminadas}&limit=${limite}`,
    );
    return dtos.map(aEmision);
  },

  /**
   * Quien de las personas a las que sigo esta emitiendo AHORA.
   *
   * Es lo que pregunta el aviso «Juan está transmitiendo en vivo» al abrir la
   * aplicacion (`AvisoDeDirectoSeguido`). Solo emisiones vivas: el servidor no
   * devuelve ni las anunciadas ni las terminadas. Pide sesion.
   */
  async enVivoDeQuienSigo(limite = 5): Promise<Emision[]> {
    const dtos = await apiRequest<EmisionDto[]>(
      `${API_V1}/live/sessions/following?limit=${limite}`,
    );
    return dtos.map(aEmision);
  },

  /**
   * Crea una emision.
   *
   * OJO con `programadaParaIso`: sin el, la emision nace YA en directo. No es
   * un descuido del backend, es lo que hace falta para el boton de «empezar
   * ahora»; quien quiera anunciarla para mas tarde tiene que mandar la fecha.
   */
  async crear(datos: DatosDeEmision): Promise<Emision> {
    const dto = await apiRequest<EmisionDto>(`${API_V1}/live/sessions`, {
      method: 'POST',
      body: JSON.stringify(cuerpoDeEmision(datos)),
    });
    return aEmision(dto);
  },

  async obtener(emisionId: string): Promise<Emision> {
    const dto = await apiRequest<EmisionDto>(`${API_V1}/live/sessions/${emisionId}`);
    return aEmision(dto);
  },

  /** Edita la ficha. Solo quien emite (lo vuelve a comprobar el servidor). */
  async actualizar(emisionId: string, cambios: DatosDeEmision): Promise<Emision> {
    const dto = await apiRequest<EmisionDto>(`${API_V1}/live/sessions/${emisionId}`, {
      method: 'PATCH',
      body: JSON.stringify(cuerpoDeEmision(cambios)),
    });
    return aEmision(dto);
  },

  /** Pasa una emision programada a directo. */
  empezar(emisionId: string): Promise<Emision> {
    return transicion(emisionId, 'start');
  },

  /** Cierra la emision: se acaba el video y se cierran chat y reacciones. */
  terminar(emisionId: string): Promise<Emision> {
    return transicion(emisionId, 'end');
  },

  /** Anula una emision que nunca llego a empezar. */
  cancelar(emisionId: string): Promise<Emision> {
    return transicion(emisionId, 'cancel');
  },

  /**
   * Informa de cuanta gente hay viendo, para que el servidor mantenga el pico.
   *
   * NO la llama la pantalla de la emision, y no es un olvido: un cliente solo
   * sabe de si mismo, asi que mandar `1` desde cada telefono no cuenta
   * espectadores, los machaca. Hacerlo bien pide presencia (Supabase Presence
   * sobre el canal de la sala) y que sea UNA sola parte quien la reporte. Queda
   * expuesto porque el endpoint existe y ese es su sitio; inventarse el numero
   * habria sido justo lo que no se puede hacer.
   */
  async reportarEspectadores(emisionId: string, cuantos: number): Promise<Emision> {
    const dto = await apiRequest<EmisionDto>(
      `${API_V1}/live/sessions/${emisionId}/viewers?count=${Math.max(0, Math.round(cuantos))}`,
      { method: 'POST' },
    );
    return aEmision(dto);
  },

  /**
   * Los ultimos 50 mensajes, en orden de conversacion.
   *
   * Es la carga inicial y tambien la fuente de verdad de QUIEN escribio cada
   * cosa: la fila que llega por Realtime trae `user_id` pero no el nombre ni el
   * avatar, porque eso son columnas de otra tabla.
   */
  async listarMensajes(emisionId: string): Promise<MensajeDeEmision[]> {
    const dtos = await apiRequest<MensajeDto[]>(
      `${API_V1}/live/sessions/${emisionId}/messages`,
    );
    return dtos.map(aMensaje);
  },

  /**
   * Escribe un mensaje en el chat.
   *
   * EL POST SOLO ESCRIBE. Lo que devuelve se ignora en la pantalla: el mensaje
   * entra por la suscripcion de Realtime, igual que el de cualquier otra
   * persona. Pintarlo tambien desde aqui daria el mismo mensaje dos veces, y
   * peor aun, con dos ordenes distintos segun cual llegara antes.
   */
  async enviarMensaje(emisionId: string, cuerpo: string): Promise<MensajeDeEmision> {
    const dto = await apiRequest<MensajeDto>(
      `${API_V1}/live/sessions/${emisionId}/messages`,
      { method: 'POST', body: JSON.stringify({ body: cuerpo }) },
    );
    return aMensaje(dto);
  },

  /** Esconde un mensaje. Moderacion de quien emite; el servidor lo verifica. */
  async ocultarMensaje(mensajeId: string): Promise<MensajeDeEmision> {
    const dto = await apiRequest<MensajeDto>(`${API_V1}/live/messages/${mensajeId}/hide`, {
      method: 'POST',
    });
    return aMensaje(dto);
  },

  /**
   * Manda el RESUMEN de reacciones acumuladas y devuelve los totales.
   *
   * Las reacciones no llegan aqui de una en una: viajan por Broadcast entre los
   * clientes —canal efimero, sin escribir en Postgres— y cada pocos segundos se
   * manda de golpe cuantas ha puesto esta persona. Por eso aguanta una rafaga
   * de veinte toques sin veinte peticiones. Ver `services/directoEnVivo.ts`.
   */
  async resumirReacciones(
    emisionId: string,
    conteos: Partial<ConteoDeReacciones>,
  ): Promise<ConteoDeReacciones> {
    const dto = await apiRequest<ResumenDeReaccionesDto>(
      `${API_V1}/live/sessions/${emisionId}/reactions`,
      { method: 'POST', body: JSON.stringify({ counts: conteos }) },
    );
    return aConteo(dto.totals);
  },

  /**
   * Pide al servidor la credencial de video, ya leida y comprobada.
   *
   * YA NO DEVUELVE `Record<string, unknown>`. El contrato del backend esta
   * cerrado —`provider`, `token`, `url`, `expires_in`, `can_publish`, `role`,
   * `room_id`— asi que se lee y se valida aqui, una vez, en lugar de que cada
   * pantalla adivine los campos. `leerCredencial` vive en `live/salaDeVideo.ts`
   * junto al tipo, que es lo que consume el SDK.
   *
   * LANZA `FalloDeCredencial`, NO un `ApiError`. Es la mitad importante: la
   * pantalla no tiene por que saber que un 503 con
   * `live_provider_not_configured` y otro con `live_provider_missing` son la
   * misma cosa para quien mira, ni que un 429 se reintenta y un 403 no.
   * Comparar codigos HTTP en la interfaz es como se rompe en silencio el dia
   * que el backend renombra uno.
   *
   * Un 200 con `provider: "none"` NO es un error —es la respuesta normal con
   * la bandera de directo apagada— y por eso vuelve como credencial valida sin
   * video, no como excepcion. Quien decide que se pinta es
   * `live/maquinaDeDirecto.ts`, y a los dos casos les toca el mismo cartel.
   */
  async solicitarCredencial(emisionId: string): Promise<CredencialDeVideo> {
    let bruto: unknown;
    try {
      bruto = await apiRequest<unknown>(`${API_V1}/live/sessions/${emisionId}/credential`, {
        method: 'POST',
      });
    } catch (error) {
      throw fallo(error);
    }

    const credencial = leerCredencial(bruto);
    if (!credencial) {
      /*
        Un 200 con un cuerpo que no es una credencial. Es `desconocido` y no
        `sin_proveedor` a proposito: «no hay proveedor» es una respuesta que el
        servidor da a sabiendas, y esto es un contrato roto —un despliegue a
        medias, un proxy que devuelve HTML—, que si vale la pena reintentar.
      */
      throw { clase: 'desconocido' } satisfies FalloDeCredencial;
    }
    return credencial;
  },

  /** Atajo: `true` si esta credencial da video de verdad. */
  hayVideo: hayVideoEnLaCredencial,

  /**
   * Si el servidor tiene proveedor de video ahora mismo.
   *
   * Lo pregunta «Vivo» antes de ofrecer emitir: encender los directos es
   * configuracion del servidor, no otra version de la app. Cualquier fallo
   * cuenta como «no hay»: ofrecer emitir sin saberlo es prometer una sala
   * que puede no tener imagen.
   */
  async disponibilidad(): Promise<boolean> {
    try {
      const dto = await apiRequest<{ video?: unknown }>(`${API_V1}/live/availability`, {
        auth: false,
      });
      return dto?.video === true;
    } catch {
      return false;
    }
  },
};

/**
 * Traduce lo que sea que haya salido de la red a un fallo del dominio.
 *
 * Se exporta porque la maquina de estados lo recibe como
 * `entorno.clasificarFallo`: asi la pantalla no tiene que capturar el error,
 * mirarlo y volver a lanzarlo.
 */
export function fallo(error: unknown): FalloDeCredencial {
  if (error instanceof ApiError) {
    /*
      `Retry-After` no llega hoy en el cuerpo uniforme del backend, pero si
      llegara en `details` esta leido: obedecer al servidor cuando dice cuanto
      esperar es lo unico que saca de un 429 a la primera.
    */
    const detalles = error.details as { retry_after?: unknown } | null | undefined;
    const segundos = detalles && typeof detalles.retry_after === 'number'
      ? detalles.retry_after
      : null;
    return clasificarFalloDeCredencial({
      status: error.status,
      code: error.code,
      esperaSugeridaMs: segundos === null ? null : segundos * 1000,
    });
  }
  // Un fallo ya clasificado (el de arriba, o `SalaNoDisponible`) pasa tal cual.
  if (typeof error === 'object' && error !== null && 'clase' in error) {
    return error as FalloDeCredencial;
  }
  // Un `AbortError` del limite de espera de `apiRequest`, o cualquier otra
  // cosa que no llego a hablar con el servidor: es red, y la red se reintenta.
  return clasificarFalloDeCredencial({ status: 0 });
}
