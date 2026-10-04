/**
 * EL CLIENTE DE SUPABASE REALTIME DE VERDAD, contra un servidor en memoria.
 *
 * NO ES PRODUCTO: solo lo importan las baterias (`*.test.mts`).
 *
 * POR QUE EXISTE (revision del 04/10/2026). La primera version de estas
 * pruebas usaba un cliente de Realtime escrito a mano, que copiaba lo que el
 * autor CREIA que hacia el de verdad. Una de esas creencias era falsa —que
 * `subscribe()` tras `removeChannel` deja un canal muerto— y la prueba que la
 * «demostraba» solo comprobaba el doble contra si mismo. Un doble escrito por
 * quien escribe el codigo tiene los mismos puntos ciegos que el codigo.
 *
 * Aqui el cliente es el `RealtimeClient` instalado en `node_modules`, sin
 * tocar. Lo unico de mentira es lo que hay al otro lado del cable: un
 * `WebSocket` que no sale a ninguna red y un servidor Phoenix minimo que solo
 * entiende lo que usan los directos (unirse, salir, latido, Broadcast y los
 * filtros de `postgres_changes`).
 *
 * Si una version futura del cliente cambia de costumbres, estas baterias
 * fallan, que es justo lo que se quiere saber antes de subirla.
 */
import { createRequire } from 'node:module';

const requerir = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { RealtimeClient } = requerir('@supabase/realtime-js') as { RealtimeClient: any };

type Enchufe = {
  nombre: string;
  readyState: number;
  onopen?: (evento: unknown) => void;
  onmessage?: (evento: { data: string }) => void;
  onclose?: (evento: { code: number; reason: string; wasClean: boolean }) => void;
};

type Dentro = { joinRef: string; conEco: boolean };

export type Trama = {
  de: string;
  topic: string;
  event: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ClienteReal = any;

export type ServidorDePrueba = {
  /** Un cliente de Realtime de verdad, enchufado a este servidor. */
  cliente: () => ClienteReal;
  /** Todo lo que los clientes han mandado, en orden. */
  tramas: Trama[];
  /** Cuantos enchufes estan unidos a un topico (`realtime:<topico>`). */
  unidos: (topico: string) => number;
  /** El servidor cierra el canal por su cuenta (`phx_close`). */
  cerrarCanal: (topico: string) => number;
  /** Se cae la red de un cliente: su enchufe se cierra de mala manera. */
  tirarLaRed: (cliente: ClienteReal) => void;
  /** Cuanto tarda el servidor en contestar. Por defecto, nada. */
  retraso: (ms: number) => void;
  /** Peticiones HTTP que ha hecho algun cliente. Tiene que ser 0. */
  peticionesHttp: () => number;
};

export const pausa = (ms = 25): Promise<void> => new Promise((resolver) => setTimeout(resolver, ms));

export function crearServidorDePrueba(): ServidorDePrueba {
  const salas = new Map<string, Map<Enchufe, Dentro>>();
  const enchufes = new Map<ClienteReal, Set<Enchufe>>();
  const tramas: Trama[] = [];
  let retraso = 0;
  let http = 0;
  let serie = 0;

  function alCliente(
    enchufe: Enchufe,
    joinRef: string | null,
    ref: string | null,
    topic: string,
    event: string,
    payload: unknown,
  ): void {
    setTimeout(() => {
      if (enchufe.readyState !== 1) return;
      enchufe.onmessage?.({ data: JSON.stringify([joinRef, ref, topic, event, payload]) });
    }, retraso);
  }

  function leer(data: unknown): { join_ref: string; ref: string; topic: string; event: string; payload: any } {
    if (typeof data === 'string') {
      const [join_ref, ref, topic, event, payload] = JSON.parse(data);
      return { join_ref, ref, topic, event, payload };
    }
    // El cliente manda el Broadcast en binario.
    const buf: ArrayBuffer = data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer as ArrayBuffer;
    const vista = new DataView(buf);
    const texto = new TextDecoder();
    const largos = [1, 2, 3, 4, 5].map((i) => vista.getUint8(i));
    let o = 7;
    const trozo = (largo: number) => {
      const valor = texto.decode(buf.slice(o, o + largo));
      o += largo;
      return valor;
    };
    const join_ref = trozo(largos[0] as number);
    const ref = trozo(largos[1] as number);
    const topic = trozo(largos[2] as number);
    const evento = trozo(largos[3] as number);
    o += largos[4] as number;
    const payload = JSON.parse(texto.decode(buf.slice(o)));
    return { join_ref, ref, topic, event: 'broadcast', payload: { type: 'broadcast', event: evento, payload } };
  }

  function recibir(enchufe: Enchufe, data: unknown): void {
    const { join_ref, ref, topic, event, payload } = leer(data);
    tramas.push({ de: enchufe.nombre, topic, event, payload });

    if (topic === 'phoenix' && event === 'heartbeat') {
      alCliente(enchufe, null, ref, 'phoenix', 'phx_reply', { status: 'ok', response: {} });
      return;
    }
    if (event === 'phx_join') {
      if (!salas.has(topic)) salas.set(topic, new Map());
      salas.get(topic)?.set(enchufe, {
        joinRef: join_ref,
        conEco: payload?.config?.broadcast?.self === true,
      });
      const cambios = (payload?.config?.postgres_changes ?? []).map((filtro: object, i: number) => ({
        ...filtro,
        id: i + 1,
      }));
      alCliente(enchufe, join_ref, ref, topic, 'phx_reply', {
        status: 'ok',
        response: { postgres_changes: cambios },
      });
      return;
    }
    if (event === 'phx_leave') {
      const sala = salas.get(topic);
      if (sala?.get(enchufe)?.joinRef === join_ref) sala.delete(enchufe);
      alCliente(enchufe, join_ref, ref, topic, 'phx_reply', { status: 'ok', response: {} });
      alCliente(enchufe, join_ref, null, topic, 'phx_close', {});
      return;
    }
    if (event === 'broadcast') {
      const sala = salas.get(topic);
      // Sin haberse unido, el servidor lo tira.
      if (!sala?.has(enchufe)) return;
      for (const [otro, datos] of sala) {
        if (otro === enchufe && !datos.conEco) continue;
        alCliente(otro, null, null, topic, 'broadcast', payload);
      }
    }
  }

  return {
    tramas,

    cliente() {
      const propios = new Set<Enchufe>();

      class EnchufeFalso {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        nombre = `ws${(serie += 1)}`;
        readyState = 0;
        bufferedAmount = 0;
        onopen?: (evento: unknown) => void;
        onmessage?: (evento: { data: string }) => void;
        onclose?: (evento: { code: number; reason: string; wasClean: boolean }) => void;
        onerror?: (evento: unknown) => void;
        constructor() {
          propios.add(this);
          setTimeout(() => {
            if (this.readyState !== 0) return;
            this.readyState = 1;
            this.onopen?.({});
          }, 0);
        }
        send(data: unknown) {
          recibir(this, data);
        }
        close(code?: number, reason?: string) {
          this.readyState = 3;
          propios.delete(this);
          for (const sala of salas.values()) sala.delete(this);
          setTimeout(() => this.onclose?.({ code: code ?? 1000, reason: reason ?? '', wasClean: true }), 0);
        }
      }

      const cliente = new RealtimeClient('ws://sin-red.invalid/realtime/v1', {
        params: { apikey: 'clave-publica-de-prueba' },
        transport: EnchufeFalso,
        // Reconecta enseguida: la prueba no espera un segundo de reloj.
        reconnectAfterMs: () => 30,
        /*
          Latido corto. Con el de serie (25 s) el cliente deja vivo ese
          temporizador aun despues de `disconnect()`, y la bateria tardaba
          medio minuto en terminar sin estar haciendo nada. El aviso de
          «sin canales, me desconecto» se deja largo para que no se cruce con
          las pruebas que se quedan un instante sin canales.
        */
        heartbeatIntervalMs: 250,
        // Y no espera diez segundos una respuesta que ya no va a llegar.
        timeout: 1_500,
        disconnectOnEmptyChannelsAfterMs: 3_000,
        // Si el cliente intenta HTTP, se apunta y se contesta como el servidor.
        fetch: async () => {
          http += 1;
          return { ok: true, status: 202, statusText: 'Accepted', body: null, json: async () => ({}) };
        },
      });
      enchufes.set(cliente, propios);
      return cliente;
    },

    unidos: (topico) => salas.get(`realtime:${topico}`)?.size ?? 0,

    cerrarCanal(topico) {
      const sala = salas.get(`realtime:${topico}`);
      if (!sala) return 0;
      let cerrados = 0;
      for (const [enchufe, datos] of [...sala]) {
        sala.delete(enchufe);
        alCliente(enchufe, datos.joinRef, null, `realtime:${topico}`, 'phx_close', {});
        cerrados += 1;
      }
      return cerrados;
    },

    tirarLaRed(cliente) {
      for (const enchufe of [...(enchufes.get(cliente) ?? [])]) {
        enchufe.readyState = 3;
        enchufes.get(cliente)?.delete(enchufe);
        for (const sala of salas.values()) sala.delete(enchufe);
        enchufe.onclose?.({ code: 1006, reason: '', wasClean: false });
      }
    },

    retraso(ms) {
      retraso = ms;
    },

    peticionesHttp: () => http,
  };
}
