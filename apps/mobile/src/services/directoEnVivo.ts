import { INTERVALO_DE_RESUMEN_MS } from '@/lib/ritmoDeChat';
import {
  esReaccion,
  LiveRepository,
  type EstadoDeEmision,
  type TipoDeReaccion,
} from '@/repositories/LiveRepository';
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
 *     manda al backend el RESUMEN acumulado. Esa es la unica razon de que esto
 *     aguante una rafaga.
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
 */
export type FilaDeMensaje = {
  id: string;
  session_id: string;
  user_id: string;
  body: string;
  created_at: string;
  hidden: boolean;
};

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

/*
  Contador para nombres de canal unicos.

  Supabase lanza «cannot add postgres_changes callbacks after subscribe()» si se
  hace `.on()` sobre un canal ya suscrito, y eso pasa en cuanto un efecto se
  vuelve a montar (React en modo estricto lo hace siempre). Mismo motivo y misma
  solucion que en `services/realtime.ts`.
*/
let secuencia = 0;

/**
 * Los mensajes de una emision, segun se escriben.
 *
 * Escucha `*` y no solo `INSERT` porque esconder un mensaje es un UPDATE: si
 * solo se oyeran las altas, un mensaje moderado seguiria en pantalla de todo el
 * mundo menos de quien lo escondio, que es lo contrario de moderar.
 */
export function suscribirseAlChat(
  emisionId: string,
  alLlegarMensaje: (fila: FilaDeMensaje) => void,
): () => void {
  const cliente = supabase;
  if (!cliente) return () => {};

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
        // En un borrado `new` viene vacio. Un mensaje del chat no se borra —se
        // esconde, que es un UPDATE—, pero salir por aqui evita entregar una
        // fila sin identificador si alguna vez lo hiciera.
        if (cambio.eventType === 'DELETE') return;
        alLlegarMensaje(cambio.new);
      },
    )
    .subscribe();

  return () => {
    void cliente.removeChannel(canal);
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
      (cambio) => alCambiar(cambio.new),
    )
    .subscribe();

  return () => {
    void cliente.removeChannel(canal);
  };
}

/** Nombre del evento de Broadcast. Lo comparten todos los clientes de la sala. */
const EVENTO_DE_REACCION = 'reaccion';

export type CanalDeReacciones = {
  /**
   * Lanza una reaccion: sale por Broadcast y se apunta para el resumen.
   *
   * Devuelve enseguida y no lanza nunca. La animacion de quien reacciona no
   * puede depender de que llegue nada.
   */
  enviar: (tipo: TipoDeReaccion) => void;
  /** Las reacciones de LOS DEMAS. Devuelve como dejar de escuchar. */
  alRecibir: (escuchar: (tipo: TipoDeReaccion) => void) => () => void;
  /** Cierra el canal y manda lo que quedara acumulado. */
  cerrar: () => void;
};

/**
 * El canal efimero de reacciones de una emision.
 *
 * Junta las dos mitades que hacen que esto funcione: el Broadcast, que las
 * reparte al instante entre quienes miran, y el acumulador, que cada
 * `INTERVALO_DE_RESUMEN_MS` manda al backend cuantas ha puesto esta persona.
 *
 * Sin Supabase configurado sigue funcionando a medias, y es la degradacion
 * correcta: no se ven las reacciones de los demas —no hay por donde— pero las
 * propias se siguen contando en el servidor.
 */
export function canalDeReacciones(emisionId: string): CanalDeReacciones {
  const cliente = supabase;
  const escuchas = new Set<(tipo: TipoDeReaccion) => void>();

  /** Lo puesto por esta persona desde el ultimo resumen. */
  let acumulado: Partial<Record<TipoDeReaccion, number>> = {};
  let temporizador: ReturnType<typeof setTimeout> | null = null;
  let cerrado = false;
  /*
    Cuando el servidor dice que las reacciones estan cerradas se deja de
    acumular. Sin esto, cada intervalo repetiria la misma peticion condenada al
    409 durante todo el rato que quede alguien con la pantalla abierta.
  */
  let admiteReacciones = true;

  secuencia += 1;
  const canal = cliente
    ? cliente.channel(`live-reacciones:${emisionId}:${secuencia}`, {
        // `self: false`: la propia reaccion no vuelve. La animacion ya se lanzo
        // en el mismo gesto, y devolverla pintaria dos corazones por un toque.
        config: { broadcast: { self: false } },
      })
    : null;

  if (canal) {
    canal
      .on('broadcast', { event: EVENTO_DE_REACCION }, (mensaje) => {
        // El payload lo escribe OTRO cliente: puede traer cualquier cosa. Se
        // valida contra la lista cerrada del backend antes de tocar la interfaz.
        const tipo = (mensaje as { payload?: { tipo?: unknown } }).payload?.tipo;
        if (!esReaccion(tipo)) return;
        escuchas.forEach((escuchar) => escuchar(tipo));
      })
      .subscribe();
  }

  async function vaciar(): Promise<void> {
    if (temporizador) {
      clearTimeout(temporizador);
      temporizador = null;
    }
    const lote = acumulado;
    if (Object.keys(lote).length === 0) return;
    acumulado = {};

    try {
      await LiveRepository.resumirReacciones(emisionId, lote);
    } catch (error) {
      const codigo = (error as { code?: string })?.code;
      if (codigo === 'live_reactions_closed') {
        admiteReacciones = false;
        return;
      }
      /*
        Lo demas se tira, y a proposito. Una reaccion perdida no la echa de
        menos nadie: el contador es agregado y la siguiente rafaga lo corrige.
        Reintentar significaria guardar el lote y mandarlo doble mas tarde,
        inflando un numero por un fallo de red.
      */
    }
  }

  function programarResumen(): void {
    if (temporizador || cerrado) return;
    temporizador = setTimeout(() => {
      temporizador = null;
      void vaciar();
    }, INTERVALO_DE_RESUMEN_MS);
  }

  return {
    enviar(tipo: TipoDeReaccion): void {
      if (cerrado) return;
      // Primero el Broadcast: es lo que ve el resto de la sala, y va sin await
      // porque nada de la interfaz espera a esta promesa.
      void canal?.send({ type: 'broadcast', event: EVENTO_DE_REACCION, payload: { tipo } });

      if (!admiteReacciones) return;
      acumulado[tipo] = (acumulado[tipo] ?? 0) + 1;
      programarResumen();
    },

    alRecibir(escuchar: (tipo: TipoDeReaccion) => void): () => void {
      escuchas.add(escuchar);
      return () => {
        escuchas.delete(escuchar);
      };
    },

    cerrar(): void {
      if (cerrado) return;
      cerrado = true;
      escuchas.clear();
      // Lo acumulado sale ANTES de soltar el canal: si no, salir de la pantalla
      // tiraria los ultimos segundos de reacciones, que son justo los de
      // cuando la persona estaba mas enganchada.
      void vaciar();
      if (canal && cliente) void cliente.removeChannel(canal);
    },
  };
}
