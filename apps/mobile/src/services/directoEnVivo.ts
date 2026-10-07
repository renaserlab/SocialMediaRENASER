import { INTERVALO_DE_RESUMEN_MS } from '@/lib/ritmoDeChat';
import { contarAudiencia, topicoDeAudiencia } from '@/live/audiencia';
import {
  crearCanalDeReacciones,
  crearTransporteDeRealtime,
  type CanalDeReacciones,
  type ClienteDeRealtime,
  type ConteoDeReacciones,
  type TransporteDeBroadcast,
} from '@/live/reaccionesEnVivo';
import { mantenerSuscripcion } from '@/live/suscripcionViva';
import { topicoDeAvisosDelChat, type FilaDeChat } from '@/live/ventanaDeChat';
import { LiveRepository, type EstadoDeEmision } from '@/repositories/LiveRepository';
import { supabase } from '@/services/supabase';

/**
 * La capa de tiempo real de una emision.
 *
 * Aqui esta la decision que define como se comporta un directo, y son DOS
 * caminos distintos a proposito:
 *
 *   - CHAT Y ESTADO DE SALA van por la BASE. `live_messages` y `live_sessions`
 *     estan en la publicacion `supabase_realtime`, asi que cada escritura llega
 *     a todo el mundo por `postgres_changes`. Se guarda porque un mensaje tiene
 *     que seguir ahi cuando alguien entra tarde, y porque la moderacion no
 *     puede esconder algo que solo existe en la memoria de otro telefono. Es el
 *     mismo patron que la mensajeria privada (`services/realtime.ts`).
 *
 *   - REACCIONES van por BROADCAST, sin tocar Postgres. Un directo animado son
 *     decenas de corazones por segundo: escribir una fila por toque llenaria la
 *     base de datos que no le importan a nadie de forma individual, y el
 *     servidor los rechazaria en bloque. Viajan por un canal efimero entre
 *     clientes —quien esta mirando lo ve al instante— y cada pocos segundos se
 *     manda al backend el RESUMEN acumulado.
 *
 * LAS REGLAS NO ESTAN AQUI. Las de las reacciones estan en
 * `live/reaccionesEnVivo.ts`, las del chat en `live/ventanaDeChat.ts` y la de
 * no quedarse con un canal muerto en `live/suscripcionViva.ts`. Ninguno
 * importa Supabase, y por eso se ejecutan en pruebas con varios clientes —y
 * contra el cliente de Realtime de verdad—. Este fichero solo les da el
 * cliente.
 *
 * TODO lo que se suscribe aqui devuelve su funcion de cancelacion. Un canal de
 * Realtime que sobrevive al desmontaje no se nota hasta que hay cinco: entonces
 * cada mensaje llega cinco veces y la lista se llena de duplicados.
 */

/**
 * Si hay tiempo real disponible.
 *
 * En modo demo (sin Supabase configurado) no lo hay, y quien llama tiene que
 * saberlo: sin esto, el chat se quedaria mudo para siempre esperando mensajes
 * que nadie va a entregar.
 */
export const hayTiempoReal = Boolean(supabase);

/**
 * Fila cruda de `live_messages` tal y como la entrega Realtime.
 *
 * NO trae nombre ni avatar: son columnas de `profiles`, y `postgres_changes`
 * manda la fila y nada mas. Quien pinte el chat necesita cruzarla con lo que
 * devolvio `LiveRepository.listarMensajes`.
 *
 * Y NO TRAE `hidden`: esa columna no existe. La tabla guarda CUANDO se
 * escondio (`hidden_at`); el `hidden` booleano es cosa de la API.
 */
export type FilaDeMensaje = FilaDeChat;

/**
 * Fila cruda de `live_sessions`.
 *
 * Solo se declaran los campos por los que se cambia algo en pantalla. El resto
 * —`can_manage`, el nombre de quien emite— no viene de la tabla, se calcula en
 * el servidor, asi que ante un cambio hay que volver a preguntarle a el.
 */
export type FilaDeEmision = {
  id: string;
  status: EstadoDeEmision;
  started_at: string | null;
  ended_at: string | null;
  viewer_peak: number | null;
};

/** Como esta el canal del chat. Lo que no es `suscrito` no entrega mensajes. */
export type EstadoDelCanalDeChat = 'conectando' | 'suscrito' | 'caido';

/** Programar con el reloj de verdad. Devuelve como cancelarlo. */
function programar(fn: () => void, ms: number): () => void {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}

/*
  Contador para nombres de canal unicos. SOLO PARA `postgres_changes`.

  Supabase lanza «cannot add postgres_changes callbacks after subscribe()» si se
  hace `.on()` sobre un canal ya suscrito, y eso pasa en cuanto dos sitios piden
  un canal con el mismo nombre: el cliente devuelve el mismo objeto. Mismo
  motivo y misma solucion que en `services/realtime.ts`.

  AQUI SE PUEDE, Y EN BROADCAST NO. En `postgres_changes` el topico es solo un
  nombre: lo que decide que llega es el filtro de la tabla, igual en todos los
  telefonos. En Broadcast el topico ES la sala, y un contador local en el topico
  pone a cada telefono en una sala distinta. Eso es justo lo que paso con las
  reacciones hasta el 04/10/2026; ver `live/reaccionesEnVivo.ts`.
*/
let secuencia = 0;

/**
 * Los mensajes de una emision, segun se escriben.
 *
 * Escucha `*` y no solo `INSERT` porque esconder un mensaje es un UPDATE. OJO:
 * ese UPDATE solo le llega a quien todavia puede leer la fila —quien modera y
 * quien la escribio—, porque Realtime aplica la politica de lectura de la
 * tabla. A los demas hay que avisarles por otro camino: `avisosDelChat`.
 *
 * `alCambiarEstado` cuenta como esta el canal. Sin eso la pantalla no podia
 * distinguir «nadie escribe» de «se ha caido el chat», ni saber cuando vuelve
 * para pedir lo que se perdio entre medias.
 */
export function suscribirseAlChat(
  emisionId: string,
  alLlegarMensaje: (fila: FilaDeMensaje) => void,
  alCambiarEstado?: (estado: EstadoDelCanalDeChat) => void,
): () => void {
  const cliente = supabase;
  if (!cliente) return () => {};

  let vigente = true;
  const dejar = mantenerSuscripcion({
    programar,
    alCambiar: (estado) => alCambiarEstado?.(estado),
    abrir: (alCambiar) => {
      secuencia += 1;
      const canal = cliente
        .channel(`live-chat:${emisionId}:${secuencia}`)
        .on<FilaDeMensaje>(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'live_messages',
            filter: `session_id=eq.${emisionId}`,
          },
          (cambio) => {
            // En un borrado `new` viene vacio. Un mensaje del chat no se borra
            // —se esconde, que es un UPDATE—, pero salir por aqui evita
            // entregar una fila sin identificador si alguna vez lo hiciera.
            if (!vigente || cambio.eventType === 'DELETE') return;
            alLlegarMensaje(cambio.new);
          },
        )
        .subscribe(alCambiar);
      return () => {
        void cliente.removeChannel(canal);
      };
    },
  });

  return () => {
    vigente = false;
    dejar();
  };
}

/**
 * Los cambios de estado de la sala.
 *
 * Entrega la fila, no una `Emision`: la tabla no sabe si quien mira puede
 * gestionarla. Sirve para reaccionar YA a lo que importa —que la emision
 * empiece o termine— y como aviso de que toca volver a pedir la ficha completa.
 */
export function suscribirseAlEstado(
  emisionId: string,
  alCambiar: (fila: FilaDeEmision) => void,
): () => void {
  const cliente = supabase;
  if (!cliente) return () => {};

  let vigente = true;
  const dejar = mantenerSuscripcion({
    programar,
    abrir: (alCambiarEstado) => {
      secuencia += 1;
      const canal = cliente
        .channel(`live-sala:${emisionId}:${secuencia}`)
        .on<FilaDeEmision>(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'live_sessions',
            filter: `id=eq.${emisionId}`,
          },
          (cambio) => {
            if (vigente) alCambiar(cambio.new);
          },
        )
        .subscribe(alCambiarEstado);
      return () => {
        void cliente.removeChannel(canal);
      };
    },
  });

  return () => {
    vigente = false;
    dejar();
  };
}

export type { CanalDeReacciones } from '@/live/reaccionesEnVivo';

/**
 * El Broadcast de este proceso. UNO: es quien garantiza que hay como mucho un
 * canal por topico (ver `crearTransporteDeRealtime`).
 */
const transporte: TransporteDeBroadcast | null = supabase
  ? crearTransporteDeRealtime(supabase as unknown as ClienteDeRealtime, { programar })
  : null;

/**
 * El canal efimero de reacciones de una emision.
 *
 * El topico es `live-reacciones:${emisionId}`, el MISMO en todos los telefonos
 * de la sala. Lo calcula `topicoDeReacciones`; aqui no se escribe.
 *
 * `alResumir` recibe los totales que devuelve el servidor despues de cada
 * resumen, para que la pantalla se ponga al dia sin contar nada dos veces.
 *
 * Sin Supabase configurado sigue funcionando a medias, y es la degradacion
 * correcta: no se ven las reacciones de los demas —no hay por donde— pero las
 * propias se siguen contando en el servidor.
 */
export function canalDeReacciones(
  emisionId: string,
  alResumir?: (totales: ConteoDeReacciones) => void,
): CanalDeReacciones {
  return crearCanalDeReacciones({
    emisionId,
    transporte,
    resumir: (conteos) => LiveRepository.resumirReacciones(emisionId, conteos),
    esCierreDeReacciones: (error) =>
      (error as { code?: string } | null)?.code === 'live_reactions_closed',
    intervaloDeResumenMs: INTERVALO_DE_RESUMEN_MS,
    programar,
    ahora: () => Date.now(),
    alResumir,
  });
}

/**
 * Cuánta gente tiene abierta la sala, según se apunta y se va.
 *
 * Es PRESENCIA, no Broadcast ni la base: cada teléfono se apunta en el canal
 * con su clave y el canal reparte la lista a todos. `clave` es la persona —su
 * identificador— o, si mira sin cuenta, una propia de este teléfono; las
 * reglas de qué cuenta y qué no están en `live/audiencia.ts`.
 *
 * EL TÓPICO ES EL MISMO EN TODOS LOS TELÉFONOS, sin contador: aquí el tópico
 * ES la sala, igual que en las reacciones. Por eso, antes de abrir, se quita el
 * canal que pudiera quedar de una visita anterior a la misma emisión: el
 * cliente devolvería ese mismo objeto, ya suscrito, y no admitiría el oyente.
 *
 * Hay que volver a apuntarse CADA VEZ que el canal se suscribe: tras una
 * caída el servidor ya no recuerda a este teléfono.
 *
 * Sin Supabase configurado no hay a quién preguntar: no se llama a
 * `alCambiar` y la pantalla no enseña número, que es mejor que enseñar un 0
 * que parece cierto.
 */
export function seguirAudiencia(
  emisionId: string,
  clave: string,
  anfitrionId: string | null,
  alCambiar: (viendo: number) => void,
): () => void {
  const cliente = supabase;
  if (!cliente || !emisionId || !clave) return () => {};

  const topico = topicoDeAudiencia(emisionId);
  let vigente = true;
  const dejar = mantenerSuscripcion({
    programar,
    abrir: (alCambiarEstado) => {
      const anterior = cliente.getChannels().find((canal) => canal.topic === `realtime:${topico}`);
      if (anterior) void cliente.removeChannel(anterior);

      const canal = cliente.channel(topico, { config: { presence: { key: clave } } });
      canal
        .on('presence', { event: 'sync' }, () => {
          if (vigente) alCambiar(contarAudiencia(canal.presenceState(), anfitrionId));
        })
        .subscribe((estado) => {
          if (estado === 'SUBSCRIBED' && vigente) void canal.track({ desde: Date.now() });
          alCambiarEstado(estado);
        });
      return () => {
        void cliente.removeChannel(canal);
      };
    },
  });

  return () => {
    vigente = false;
    dejar();
  };
}

export type AvisosDelChat = {
  /** «Algo ha cambiado en el chat: vuelve a leer». `false` = no salio. */
  avisar: () => boolean;
  cerrar: () => void;
};

/**
 * El aviso de que el chat ha cambiado por algo que NO llega por la base.
 *
 * Hoy es una sola cosa: alguien ha moderado. Esconder un mensaje es un cambio
 * que Realtime solo entrega a quien todavia puede leerlo, asi que el publico
 * no se entera y el mensaje se queda en su pantalla. Quien modera manda por
 * Broadcast un aviso SIN CONTENIDO, y quien lo recibe vuelve a leer del
 * servidor, que es quien dice que se ve y que no.
 *
 * EL AVISO NO TIENE AUTORIDAD. El canal es publico: lo puede mandar cualquiera
 * con la clave publica de la aplicacion. Por eso no dice QUE esconder —nadie
 * puede hacer desaparecer un mensaje ajeno mandandolo— y por eso quien lo
 * recibe lee como mucho una vez cada pocos segundos (`crearChatEnVivo`).
 */
export function avisosDelChat(emisionId: string, alAvisar: () => void): AvisosDelChat {
  if (!transporte) return { avisar: () => false, cerrar: () => {} };
  const conexion = transporte.abrir(topicoDeAvisosDelChat(emisionId), {
    // Lo que traiga el mensaje da igual: solo cuenta que ha llegado.
    alRecibir: () => alAvisar(),
    alCambiarEstado: () => {},
  });
  return {
    avisar: () => conexion.enviar({ v: 1 }),
    cerrar: () => conexion.cerrar(),
  };
}
