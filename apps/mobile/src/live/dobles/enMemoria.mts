/**
 * DOBLES EN MEMORIA para probar los directos con VARIOS clientes.
 *
 * NO SON PRODUCTO: solo los importan las baterias (`*.test.mts`).
 *
 * Cada uno existe porque sin el la prueba seria «buscar un texto en el
 * fichero», que es exactamente la clase de prueba que dejo pasar el defecto de
 * los topicos:
 *
 *   - `crearReloj`: el tiempo, a mano. Las ventanas de envio, el resumen y los
 *     tics de burbujas se comprueban avanzando milisegundos, no esperando.
 *   - `crearRedDeBroadcast`: una sala de Broadcast. Reparte por TOPICO, no
 *     devuelve a quien envia, pierde lo que se manda sin suscripcion, y se
 *     puede cortar. Varios «telefonos» comparten la red.
 *   - `crearBaseDeMensajes`: la tabla `live_messages` con su tiempo real y su
 *     endpoint de lectura, CON SUS REGLAS: la fila no trae el nombre de quien
 *     escribe ni un `hidden`, y un mensaje escondido solo se le entrega —y
 *     solo se le devuelve— a quien modera y a quien lo escribio.
 *
 * LO QUE YA NO HAY AQUI: un cliente de Supabase Realtime escrito a mano. Lo
 * hubo, y copiaba lo que el autor creia que hacia el de verdad; una de esas
 * creencias era falsa y la prueba que la «demostraba» pasaba igual. El
 * transporte se prueba ahora contra el cliente instalado
 * (`realtimeDeVerdad.mts`).
 */
import type {
  EstadoDeTransporte,
  OyenteDeTransporte,
  TransporteDeBroadcast,
} from '../reaccionesEnVivo.ts';
import type { FilaDeChat, MensajeDeChat } from '../ventanaDeChat.ts';

/* ------------------------------------------------------------------------- *
 * EL RELOJ
 * ------------------------------------------------------------------------- */

export type Reloj = {
  programar: (fn: () => void, ms: number) => () => void;
  ahora: () => number;
  /** Avanza el tiempo ejecutando, en orden, lo que venza por el camino. */
  avanzar: (ms: number) => void;
  /** Cuantos temporizadores hay vivos. Cero = nada se quedo colgado. */
  vivos: () => number;
};

export function crearReloj(inicio = 1_000_000): Reloj {
  type Cita = { cuando: number; orden: number; fn: () => void };
  let ahora = inicio;
  let orden = 0;
  let citas: Cita[] = [];

  return {
    programar(fn, ms) {
      const cita: Cita = { cuando: ahora + Math.max(0, ms), orden: (orden += 1), fn };
      citas.push(cita);
      return () => {
        citas = citas.filter((otra) => otra !== cita);
      };
    },
    ahora: () => ahora,
    avanzar(ms) {
      const hasta = ahora + ms;
      for (;;) {
        const vencidas = citas
          .filter((cita) => cita.cuando <= hasta)
          .sort((a, b) => a.cuando - b.cuando || a.orden - b.orden);
        const siguiente = vencidas[0];
        if (!siguiente) break;
        citas = citas.filter((cita) => cita !== siguiente);
        ahora = Math.max(ahora, siguiente.cuando);
        siguiente.fn();
      }
      ahora = hasta;
    },
    vivos: () => citas.length,
  };
}

/** Deja correr las promesas pendientes. */
export async function asentar(vueltas = 30): Promise<void> {
  for (let i = 0; i < vueltas; i += 1) await Promise.resolve();
}

/* ------------------------------------------------------------------------- *
 * LA RED DE BROADCAST
 * ------------------------------------------------------------------------- */

type Enlace = {
  telefono: string;
  topico: string;
  oyente: OyenteDeTransporte;
  suscrito: boolean;
};

export type RedDeBroadcast = {
  /**
   * El Broadcast de UN telefono. `suscribeSolo: false` deja la suscripcion
   * pendiente hasta `confirmar`, para probar lo que pasa antes de `SUBSCRIBED`.
   */
  telefono: (nombre: string, opciones?: { suscribeSolo?: boolean }) => TransporteDeBroadcast;
  /** Confirma las suscripciones pendientes de un telefono. */
  confirmar: (nombre: string) => void;
  /** El telefono pierde la red: sus canales pasan a `caido`. */
  cortar: (nombre: string) => void;
  /** Vuelve la red: sus canales vuelven a `suscrito`. */
  restablecer: (nombre: string) => void;
  /** Mete un mensaje en un topico como lo haria un cliente cualquiera. */
  inyectar: (topico: string, carga: unknown) => void;
  /** Canales abiertos ahora (de un topico, o todos). Cero = sin huerfanos. */
  abiertos: (topico?: string) => number;
  /** Los topicos que se han llegado a abrir, por telefono. */
  topicosDe: (nombre: string) => string[];
  cuenta: {
    /** Mensajes que un cliente entrego a la red. */
    enviados: number;
    /** Entregas a suscriptores: un envio a N oyentes son N. */
    entregas: number;
    /** Envios rechazados por no haber suscripcion. */
    rechazados: number;
  };
};

export function crearRedDeBroadcast(): RedDeBroadcast {
  let enlaces: Enlace[] = [];
  const historial = new Map<string, string[]>();
  const cuenta = { enviados: 0, entregas: 0, rechazados: 0 };

  function estado(enlace: Enlace, nuevo: EstadoDeTransporte): void {
    enlace.suscrito = nuevo === 'suscrito';
    enlace.oyente.alCambiarEstado(nuevo);
  }

  function repartir(topico: string, carga: unknown, origen: Enlace | null): void {
    // Copia en JSON: por la red viaja texto, no el objeto de quien envia.
    const texto = JSON.stringify(carga);
    for (const enlace of [...enlaces]) {
      if (enlace === origen || enlace.topico !== topico || !enlace.suscrito) continue;
      cuenta.entregas += 1;
      enlace.oyente.alRecibir(texto === undefined ? undefined : JSON.parse(texto));
    }
  }

  return {
    telefono(nombre, opciones = {}) {
      const suscribeSolo = opciones.suscribeSolo !== false;
      return {
        abrir(topico, oyente) {
          const enlace: Enlace = { telefono: nombre, topico, oyente, suscrito: false };
          enlaces.push(enlace);
          historial.set(nombre, [...(historial.get(nombre) ?? []), topico]);
          // A proposito DENTRO de `abrir`: asi se prueba que quien abre no lee
          // su propia conexion antes de tenerla.
          if (suscribeSolo) estado(enlace, 'suscrito');
          let cerrado = false;
          return {
            enviar(carga) {
              if (cerrado || !enlace.suscrito) {
                cuenta.rechazados += 1;
                return false;
              }
              cuenta.enviados += 1;
              repartir(topico, carga, enlace);
              return true;
            },
            cerrar() {
              if (cerrado) return;
              cerrado = true;
              enlaces = enlaces.filter((otro) => otro !== enlace);
            },
          };
        },
      };
    },

    confirmar(nombre) {
      for (const enlace of [...enlaces]) {
        if (enlace.telefono === nombre && !enlace.suscrito) estado(enlace, 'suscrito');
      }
    },

    cortar(nombre) {
      for (const enlace of [...enlaces]) {
        if (enlace.telefono === nombre && enlace.suscrito) estado(enlace, 'caido');
      }
    },

    restablecer(nombre) {
      for (const enlace of [...enlaces]) {
        if (enlace.telefono === nombre && !enlace.suscrito) estado(enlace, 'suscrito');
      }
    },

    inyectar(topico, carga) {
      repartir(topico, carga, null);
    },

    abiertos(topico) {
      return enlaces.filter((enlace) => topico === undefined || enlace.topico === topico).length;
    },

    topicosDe(nombre) {
      return [...(historial.get(nombre) ?? [])];
    },

    cuenta,
  };
}

/* ------------------------------------------------------------------------- *
 * LA BASE DE MENSAJES
 * ------------------------------------------------------------------------- */

/** Quien lee: lo que la politica de lectura y la API miran de una persona. */
export type Lector = {
  id: string;
  /** Gestiona la emision (anfitrion o administracion): ve lo escondido. */
  modera: boolean;
};

type Suscriptor = {
  emisionId: string;
  lector: Lector;
  alLlegar: (fila: FilaDeChat) => void;
  conectado: boolean;
};

export type SuscripcionDeMensajes = {
  dejar: () => void;
  /** Se cae el canal: lo que se escriba ahora no le llega. */
  cortar: () => void;
  volver: () => void;
};

export type BaseDeMensajes = {
  /** Lo que hace `POST /messages`: guarda y lo reparte por tiempo real. */
  escribir: (emisionId: string, usuario: { id: string; nombre: string }, cuerpo: string) => FilaDeChat;
  /**
   * Lo que hace `POST /messages/{id}/hide`: pone `hidden_at`. El cambio SOLO
   * se le entrega a quien todavia puede leer la fila.
   */
  ocultar: (mensajeId: string) => void;
  /** Lo que hace `GET /messages`: los ultimos QUE ESA PERSONA PUEDE VER. */
  ultimos: (emisionId: string, lector: Lector, limite?: number) => Promise<MensajeDeChat[]>;
  /** `bloqueado` deja de aparecer en las lecturas de `lector`. */
  bloquear: (lectorId: string, bloqueadoId: string) => void;
  suscribir: (
    emisionId: string,
    lector: Lector,
    alLlegar: (fila: FilaDeChat) => void,
  ) => SuscripcionDeMensajes;
  /** Lecturas servidas. Es lo que se acota en una rafaga. */
  lecturas: () => number;
  suscriptores: () => number;
  /** Hace que las lecturas fallen (o dejen de fallar). */
  queFalle: (valor: boolean) => void;
};

export function crearBaseDeMensajes(reloj: Reloj): BaseDeMensajes {
  const filas: FilaDeChat[] = [];
  const nombres = new Map<string, string>();
  const bloqueos = new Map<string, Set<string>>();
  let suscriptores: Suscriptor[] = [];
  let lecturas = 0;
  let falla = false;
  let serie = 0;

  /** La politica `live_messages_read`: lo escondido, a quien modera y al autor. */
  function puedeLeer(fila: FilaDeChat, lector: Lector): boolean {
    return fila.hidden_at === null || lector.modera || fila.user_id === lector.id;
  }

  function repartir(fila: FilaDeChat): void {
    for (const suscriptor of [...suscriptores]) {
      if (suscriptor.emisionId !== fila.session_id || !suscriptor.conectado) continue;
      // Realtime aplica la politica de lectura a la fila NUEVA: a quien ya no
      // puede leerla no le manda nada.
      if (!puedeLeer(fila, suscriptor.lector)) continue;
      // Copia: cada cliente recibe su propio objeto, como por la red.
      suscriptor.alLlegar({ ...fila });
    }
  }

  return {
    escribir(emisionId, usuario, cuerpo) {
      serie += 1;
      nombres.set(usuario.id, usuario.nombre);
      const fila: FilaDeChat = {
        id: `msg-${String(serie).padStart(6, '0')}`,
        session_id: emisionId,
        user_id: usuario.id,
        body: cuerpo,
        // Un milisegundo por mensaje: el orden de escritura es el de la hora.
        // Con microsegundos y `+00:00`, que es como lo da PostgreSQL.
        created_at: new Date(reloj.ahora() + serie).toISOString().replace('Z', '000+00:00'),
        hidden_at: null,
      };
      filas.push(fila);
      repartir(fila);
      return fila;
    },

    ocultar(mensajeId) {
      const fila = filas.find((otra) => otra.id === mensajeId);
      if (!fila) return;
      fila.hidden_at = new Date(reloj.ahora()).toISOString();
      repartir(fila);
    },

    async ultimos(emisionId, lector, limite = 50) {
      lecturas += 1;
      if (falla) throw new Error('sin red');
      const bloqueados = bloqueos.get(lector.id);
      return filas
        .filter((fila) => fila.session_id === emisionId)
        .filter((fila) => puedeLeer(fila, lector))
        .filter((fila) => !bloqueados?.has(fila.user_id))
        .slice(-limite)
        .map((fila) => ({
          id: fila.id,
          emisionId: fila.session_id,
          usuarioId: fila.user_id,
          usuarioNombre: nombres.get(fila.user_id) ?? '',
          cuerpo: fila.body,
          creadoEnIso: fila.created_at,
          // El booleano lo calcula la API; la tabla solo tiene `hidden_at`.
          oculto: fila.hidden_at !== null,
        }));
    },

    bloquear(lectorId, bloqueadoId) {
      if (!bloqueos.has(lectorId)) bloqueos.set(lectorId, new Set());
      bloqueos.get(lectorId)?.add(bloqueadoId);
    },

    suscribir(emisionId, lector, alLlegar) {
      const suscriptor: Suscriptor = { emisionId, lector, alLlegar, conectado: true };
      suscriptores.push(suscriptor);
      return {
        dejar() {
          suscriptores = suscriptores.filter((otro) => otro !== suscriptor);
        },
        cortar() {
          suscriptor.conectado = false;
        },
        volver() {
          suscriptor.conectado = true;
        },
      };
    },

    lecturas: () => lecturas,
    suscriptores: () => suscriptores.length,
    queFalle(valor) {
      falla = valor;
    },
  };
}
