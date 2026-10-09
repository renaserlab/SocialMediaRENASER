import { leerDestacado, type Destacado, type EstiloDeRotulo } from '@/live/destacado';
import { leerEscenario, type Escenario } from '@/live/escenario';
import {
  clasificarFalloDeCredencial,
  type FalloDeCredencial,
} from '@/live/maquinaDeDirecto';
import {
  REACCIONES,
  reaccionesVacias,
  type ConteoDeReacciones,
} from '@/live/reaccionesEnVivo';
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

/*
  La lista cerrada de reacciones vive en `live/reaccionesEnVivo.ts`, junto a
  quien valida lo que llega por Broadcast, para que ese modulo se pueda ejecutar
  en las pruebas sin arrastrar la capa de red. Se reexporta desde aqui porque
  es de aqui de donde la importa el resto de la aplicacion.
*/
export {
  REACCIONES,
  esReaccion,
  reaccionesVacias,
  type ConteoDeReacciones,
  type TipoDeReaccion,
} from '@/live/reaccionesEnVivo';

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
  async solicitarCredencial(
    emisionId: string,
    { publicar = true }: { publicar?: boolean } = {},
  ): Promise<CredencialDeVideo> {
    let bruto: unknown;
    try {
      bruto = await apiRequest<unknown>(`${API_V1}/live/sessions/${emisionId}/credential`, {
        method: 'POST',
        /*
          Lo unico que se le puede decir al servidor: que NO se quiere publicar.
          El rol lo sigue decidiendo el; `publish: true` sin derecho no da nada.
          Ver `EntornoDeDirecto.pedirCredencial`.
        */
        body: JSON.stringify({ publish: publicar }),
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

  /* ------------------------------------------------------- El escenario -- */
  /*
    A quien se invita a salir con su camara (`live/escenario.ts`). Todas
    devuelven el escenario ENTERO tal como queda, visto por quien pregunta:
    asi la pantalla no tiene que componer el estado nuevo a partir del gesto,
    que es como acaba diciendo una cosa mientras el servidor dice otra.

    Un servidor sin la migracion 0098 contesta 503 `live_guests_not_available`
    y uno anterior a esta funcion, 404. Las dos cosas significan «aqui no se
    puede invitar»: lo decide `sinInvitados`.
  */

  /** El escenario de una emision. */
  async escenario(emisionId: string): Promise<Escenario> {
    return aEscenario(
      await apiRequest<unknown>(`${API_V1}/live/sessions/${emisionId}/guests`),
    );
  },

  /** Invitar a una persona. Solo quien gestiona la emision. */
  async invitar(emisionId: string, usuarioId: string): Promise<Escenario> {
    return aEscenario(
      await apiRequest<unknown>(`${API_V1}/live/sessions/${emisionId}/guests`, {
        method: 'POST',
        body: JSON.stringify({ user_id: usuarioId }),
      }),
    );
  },

  /** Quitar a alguien de la pantalla, o retirarle la invitacion. */
  async quitarInvitado(emisionId: string, usuarioId: string): Promise<Escenario> {
    return aEscenario(
      await apiRequest<unknown>(`${API_V1}/live/sessions/${emisionId}/guests/${usuarioId}`, {
        method: 'DELETE',
      }),
    );
  },

  /** Contestar a la invitacion propia. */
  async responderInvitacion(emisionId: string, acepta: boolean): Promise<Escenario> {
    return aEscenario(
      await apiRequest<unknown>(
        `${API_V1}/live/sessions/${emisionId}/guests/me/${acepta ? 'accept' : 'decline'}`,
        { method: 'POST' },
      ),
    );
  },

  /** Bajarse. Siempre se puede. */
  async dejarEscenario(emisionId: string): Promise<Escenario> {
    return aEscenario(
      await apiRequest<unknown>(`${API_V1}/live/sessions/${emisionId}/guests/me/leave`, {
        method: 'POST',
      }),
    );
  },

  /* ------------------------------------------------------- Lo destacado -- */
  /*
    El mensaje fijado y el rotulo de quien emite (`live/destacado.ts`). Igual
    que con el escenario, todas devuelven lo destacado ENTERO tal como queda:
    la pantalla pinta lo que contesta el servidor, no lo que cree haber hecho.

    Un servidor sin la migracion 0099 contesta 503
    `live_spotlight_not_available` y uno anterior a esta funcion, 404. Las dos
    cosas significan «aqui no se puede destacar»: lo decide `sinDestacado`.
  */

  /** Lo destacado de una emision. Se puede leer sin cuenta. */
  async destacado(emisionId: string): Promise<DestacadoDeEmision> {
    return aDestacado(
      await apiRequest<unknown>(`${API_V1}/live/sessions/${emisionId}/spotlight`),
    );
  },

  /** Fijar un mensaje del chat. Solo quien gestiona la emision. */
  async fijarMensaje(emisionId: string, mensajeId: string): Promise<DestacadoDeEmision> {
    return aDestacado(
      await apiRequest<unknown>(`${API_V1}/live/sessions/${emisionId}/spotlight/pin`, {
        method: 'PUT',
        body: JSON.stringify({ message_id: mensajeId }),
      }),
    );
  },

  /** Dejar de fijar. Si no habia nada fijado, no pasa nada. */
  async soltarMensaje(emisionId: string): Promise<DestacadoDeEmision> {
    return aDestacado(
      await apiRequest<unknown>(`${API_V1}/live/sessions/${emisionId}/spotlight/pin`, {
        method: 'DELETE',
      }),
    );
  },

  /** Poner o cambiar el texto que quien emite ensena sobre la imagen. */
  async ponerRotulo(
    emisionId: string,
    texto: string,
    estilo: EstiloDeRotulo,
  ): Promise<DestacadoDeEmision> {
    return aDestacado(
      await apiRequest<unknown>(`${API_V1}/live/sessions/${emisionId}/spotlight/banner`, {
        method: 'PUT',
        body: JSON.stringify({ text: texto, style: estilo }),
      }),
    );
  },

  /** Quitar el rotulo. Si no habia ninguno, no pasa nada. */
  async quitarRotulo(emisionId: string): Promise<DestacadoDeEmision> {
    return aDestacado(
      await apiRequest<unknown>(`${API_V1}/live/sessions/${emisionId}/spotlight/banner`, {
        method: 'DELETE',
      }),
    );
  },

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
/** Lo destacado de una emision, con el mensaje ya en la forma de la aplicacion. */
export type DestacadoDeEmision = Destacado<MensajeDeEmision>;

function aDestacado(bruto: unknown): DestacadoDeEmision {
  const destacado = leerDestacado<MensajeDeEmision>(bruto, aMensaje);
  // Un 200 que no es lo destacado: contrato roto, no «no hay nada destacado».
  if (!destacado) throw new Error('El servidor no devolvió lo destacado.');
  return destacado;
}

function aEscenario(bruto: unknown): Escenario {
  const escenario = leerEscenario(bruto);
  // Un 200 que no es un escenario: contrato roto, no «no hay invitados».
  if (!escenario) throw new Error('El servidor no devolvió el escenario.');
  return escenario;
}

/**
 * ¿Este fallo significa «en este servidor no se puede invitar»?
 *
 * Es lo que hace que la aplicacion NO ensene el boton de invitar: el servidor
 * todavia no tiene la tabla, o es anterior a la funcion. Cualquier otro fallo
 * —la red, un 500— no dice eso y no puede esconder el boton.
 */
export function sinInvitados(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.code === 'live_guests_not_available' || error.status === 404;
}

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
