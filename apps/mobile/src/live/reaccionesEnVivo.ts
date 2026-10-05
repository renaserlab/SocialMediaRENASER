/**
 * LAS REACCIONES DE UN DIRECTO, sin Supabase, sin React y sin red delante.
 *
 * POR QUE ESTE FICHERO EXISTE. Hasta el 04/10/2026 esta logica vivia dentro de
 * `services/directoEnVivo.ts`, pegada al cliente de Supabase, y por eso no se
 * podia ejecutar en una prueba. Asi paso el defecto que la motivo: el canal se
 * abria con
 *
 *     live-reacciones:${emisionId}:${secuencia}
 *
 * donde `secuencia` es un contador LOCAL de cada telefono. Dos telefonos en la
 * misma emision abrian topicos distintos —`...:3` y `...:7`— y nadie escuchaba
 * a nadie. Quien pulsaba veia su corazon, porque la animacion propia no pasa
 * por la red, y los totales acababan cuadrando con el resumen al servidor; lo
 * unico que no llegaba nunca era la reaccion de los demas. Una prueba que
 * buscara el texto `live-reacciones` en el fichero habria pasado en verde.
 *
 * Aqui esta todo lo que tiene reglas, y entra por parametros lo que toca el
 * mundo: el transporte (Broadcast), el resumen al servidor, el reloj.
 *
 * TRES NUMEROS DISTINTOS, QUE NO SE MEZCLAN:
 *
 *   - el TOTAL PERSISTIDO, que es del servidor y sale del resumen;
 *   - las ANIMACIONES que se pintan, que son una muestra (`live/burbujas.ts`);
 *   - los EVENTOS TRANSPORTADOS, que son los mensajes de Broadcast.
 *
 * Un toque suma uno al primero, puede no pintar burbuja en el telefono de otro
 * y casi nunca es un mensaje propio en la red.
 *
 * NO IMPORTA NADA, a proposito: asi se ejecuta con `node --test`.
 */

/* ------------------------------------------------------------------------- *
 * LA LISTA CERRADA. Es la del backend (`live_reaction_totals.kind`).
 * ------------------------------------------------------------------------- */

/**
 * Las reacciones que acepta el servidor, en el orden en que se pintan.
 *
 * Vive aqui —y `LiveRepository` la reexporta— porque el canal de Broadcast
 * recibe lo que mande CUALQUIER otro cliente, y `esReaccion` es lo que impide
 * que un payload inventado acabe contando como reaccion.
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

/* ------------------------------------------------------------------------- *
 * EL TOPICO. La correccion entera cabe en esta funcion.
 * ------------------------------------------------------------------------- */

/**
 * El topico de Broadcast de una emision. CANONICO: solo depende de la emision.
 *
 * Todos los telefonos de la sala tienen que calcular EXACTAMENTE el mismo
 * texto, asi que aqui no puede entrar nada local: ni un contador, ni la hora,
 * ni el usuario. Los canales de `postgres_changes` si llevan contador
 * (`services/directoEnVivo.ts`), y pueden: ahi el topico es solo un nombre y
 * quien decide que llega es el filtro de la tabla. En Broadcast el topico ES la
 * sala.
 */
export function topicoDeReacciones(emisionId: string): string {
  return `live-reacciones:${emisionId}`;
}

/** Nombre del evento de Broadcast. Lo comparten todos los clientes. */
export const EVENTO_DE_REACCION = 'reaccion';

/* ------------------------------------------------------------------------- *
 * LIMITES. Todos acotan algo que, sin tope, crece con la audiencia.
 * ------------------------------------------------------------------------- */

/**
 * Cada cuanto sale, como mucho, un mensaje de reacciones de este telefono.
 *
 * El primer toque sale al momento. Los siguientes, mientras dure la ventana,
 * se juntan en UN mensaje con sus cantidades. Asi un dedo rapido —diez toques
 * por segundo— son tres o cuatro mensajes por segundo y no diez, y quien mira
 * recibe lo mismo: tipo y cantidad.
 */
export const VENTANA_DE_ENVIO_MS = 300;

/**
 * Cuantas reacciones de un tipo caben en UN mensaje.
 *
 * Vale en los dos sentidos. Al enviar, lo que no cabe espera a la ventana
 * siguiente. Al recibir, es lo unico que impide que alguien mande «un millon de
 * corazones» en un solo mensaje y deje el contador de todos en un numero que no
 * significa nada: el canal es publico y lo escribe cualquiera con la clave
 * publica de la aplicacion.
 */
export const MAXIMO_POR_MENSAJE = 12;

/**
 * Cuantas reacciones propias pueden estar esperando a salir.
 *
 * Esperan cuando el canal aun no se ha suscrito, cuando se cae, o cuando se
 * pulsa mas deprisa de lo que cabe en un mensaje. Pasado el tope se descartan
 * las NUEVAS: son animaciones para los demas, no estado. El total que se
 * guarda va por otro camino (el resumen) y no pierde nada por esto.
 */
export const TOPE_DE_PENDIENTES = 60;

/**
 * Cuanto se guarda una reaccion que no pudo salir.
 *
 * Una reaccion es de AHORA. Si el canal tarda mas que esto en volver, soltar
 * de golpe los corazones de hace un minuto seria contar una mentira sobre lo
 * que esta pasando en la emision.
 */
export const CADUCIDAD_DE_PENDIENTES_MS = 10_000;

/**
 * Cuantas reacciones, entre todos los tipos, admite el servidor en UN resumen.
 *
 * Es `LIMITE_POR_ENVIO` de `apps/api/app/modules/live/limites.py`, que recorta
 * en ese mismo orden. Se recorta tambien aqui para no mandar un numero que el
 * servidor va a ignorar.
 */
export const LIMITE_DE_RESUMEN = 200;

/* ------------------------------------------------------------------------- *
 * LO QUE VIAJA.
 * ------------------------------------------------------------------------- */

/** Un mensaje de reacciones: que tipos y cuantas de cada uno. */
export type CargaDeReacciones = { v: 1; conteos: Partial<ConteoDeReacciones> };

/**
 * Lee lo que mando OTRO cliente. Devuelve `null` si no sirve.
 *
 * El payload lo escribe otro telefono —o cualquiera con la clave publica—, asi
 * que puede traer cualquier cosa. Esta funcion NO LANZA NUNCA: lo que devuelve
 * acaba en el estado de un componente, y una excepcion aqui seria una pantalla
 * rota por un mensaje ajeno.
 *
 * Acepta dos formas:
 *   - `{ conteos: { corazon: 3, fuego: 1 } }`, la de ahora;
 *   - `{ tipo: 'corazon' }`, un toque suelto.
 *
 * Solo cuentan los cinco tipos de `REACCIONES`, con cantidades enteras de 1 a
 * `MAXIMO_POR_MENSAJE` (lo que pase de ahi se recorta, no se rechaza).
 */
export function leerReaccionRemota(carga: unknown): Partial<ConteoDeReacciones> | null {
  try {
    if (!carga || typeof carga !== 'object' || Array.isArray(carga)) return null;
    const mensaje = carga as { tipo?: unknown; conteos?: unknown };

    if (esReaccion(mensaje.tipo)) return { [mensaje.tipo]: 1 };

    const crudo = mensaje.conteos;
    if (!crudo || typeof crudo !== 'object' || Array.isArray(crudo)) return null;
    const salida: Partial<ConteoDeReacciones> = {};
    let alguna = false;
    for (const tipo of REACCIONES) {
      const valor = (crudo as Record<string, unknown>)[tipo];
      if (typeof valor !== 'number' || !Number.isFinite(valor)) continue;
      const cuantas = Math.min(Math.floor(valor), MAXIMO_POR_MENSAJE);
      if (cuantas < 1) continue;
      salida[tipo] = cuantas;
      alguna = true;
    }
    return alguna ? salida : null;
  } catch {
    return null;
  }
}

/** Cuantas reacciones hay en un conteo, entre todos los tipos. */
export function cuantasHay(conteos: Partial<ConteoDeReacciones>): number {
  let total = 0;
  for (const tipo of REACCIONES) total += conteos[tipo] ?? 0;
  return total;
}

/* ------------------------------------------------------------------------- *
 * EL CONTADOR QUE SE VE.
 * ------------------------------------------------------------------------- */

/**
 * Suma un lote al contador de la pantalla. Una vez por reaccion.
 *
 * Devuelve un objeto NUEVO: es estado de React.
 */
export function sumarReacciones(
  totales: ConteoDeReacciones,
  conteos: Partial<ConteoDeReacciones>,
): ConteoDeReacciones {
  const salida = { ...totales };
  for (const tipo of REACCIONES) {
    const cuantas = conteos[tipo];
    if (typeof cuantas === 'number' && cuantas > 0) salida[tipo] += cuantas;
  }
  return salida;
}

/**
 * Lo que dice el servidor despues de un resumen, contra lo que ya se pinta.
 *
 * SE QUEDA CON EL MAYOR DE LOS DOS, POR TIPO. NUNCA SUMA. El total del
 * servidor ya incluye lo que esta pantalla conto —lo propio y lo ajeno—, asi
 * que sumarlo encima contaria cada reaccion dos veces. Y no baja: el servidor
 * va unos segundos por detras (cada telefono resume cada cinco), y un numero
 * que retrocede delante de quien acaba de pulsar parece un fallo.
 *
 * Al RECARGAR la emision no se usa esto: la ficha que llega del servidor
 * sustituye al contador entero. Esa es la fuente de verdad.
 */
export function conciliarConElServidor(
  visibles: ConteoDeReacciones,
  delServidor: ConteoDeReacciones,
): ConteoDeReacciones {
  let cambia = false;
  const salida = { ...visibles };
  for (const tipo of REACCIONES) {
    if (delServidor[tipo] > salida[tipo]) {
      salida[tipo] = delServidor[tipo];
      cambia = true;
    }
  }
  // La misma referencia si nada cambia: React no repinta por un resumen que
  // no dice nada nuevo.
  return cambia ? salida : visibles;
}

/**
 * Recorta un resumen a lo que admite el servidor, en el orden en que el lo
 * recorta (`limites.acotar_envio`).
 */
export function acotarResumen(conteos: Partial<ConteoDeReacciones>): Partial<ConteoDeReacciones> {
  const salida: Partial<ConteoDeReacciones> = {};
  let restante = LIMITE_DE_RESUMEN;
  for (const tipo of REACCIONES) {
    const cuantas = conteos[tipo] ?? 0;
    if (cuantas <= 0 || restante <= 0) continue;
    const cabe = Math.min(Math.floor(cuantas), restante);
    salida[tipo] = cabe;
    restante -= cabe;
  }
  return salida;
}

/* ------------------------------------------------------------------------- *
 * EL TRANSPORTE. Lo que se le pide a Broadcast, y nada mas.
 * ------------------------------------------------------------------------- */

/**
 * - `suscrito`: el servidor confirmo la suscripcion. Se puede enviar y llega.
 * - `caido`: todavia no, o se perdio. Lo que se envie ahora NO llega.
 * - `cerrado`: se cerro. No va a volver.
 */
export type EstadoDeTransporte = 'suscrito' | 'caido' | 'cerrado';

export type OyenteDeTransporte = {
  alRecibir: (carga: unknown) => void;
  alCambiarEstado: (estado: EstadoDeTransporte) => void;
};

export type ConexionDeBroadcast = {
  /**
   * Entrega un mensaje a la red. `false` = no se entrego (no hay suscripcion):
   * quien llama decide si lo guarda. NUNCA cae a otro camino por su cuenta.
   */
  enviar: (carga: unknown) => boolean;
  /** Suelta la conexion. Idempotente. */
  cerrar: () => void;
};

export type TransporteDeBroadcast = {
  abrir: (topico: string, oyente: OyenteDeTransporte) => ConexionDeBroadcast;
};

/* ------------------------------------------------------------------------- *
 * EL TRANSPORTE DE VERDAD, sobre un cliente de Realtime.
 * ------------------------------------------------------------------------- */

/** Lo minimo que se usa de un canal de Supabase Realtime. */
export type CanalDeRealtime = {
  on: (
    tipo: 'broadcast',
    filtro: { event: string },
    alLlegar: (mensaje: { payload?: unknown }) => void,
  ) => CanalDeRealtime;
  subscribe: (alCambiar?: (estado: string) => void) => CanalDeRealtime;
  send: (mensaje: { type: 'broadcast'; event: string; payload: unknown }) => Promise<unknown>;
};

/** Lo minimo que se usa del cliente de Supabase. */
export type ClienteDeRealtime = {
  channel: (
    topico: string,
    opciones: { config: { broadcast: { self: boolean } } },
  ) => CanalDeRealtime;
  removeChannel: (canal: CanalDeRealtime) => Promise<unknown>;
};

/**
 * Cuanto se espera antes de volver a montar un canal que cerro el servidor.
 * Se dobla en cada intento seguido, hasta el tope.
 */
export const ESPERA_DE_REMONTAJE_MS = 2_000;
export const ESPERA_MAXIMA_DE_REMONTAJE_MS = 30_000;

/**
 * Broadcast sobre Supabase Realtime, con UN canal por topico en todo el
 * proceso.
 *
 * POR QUE HACE FALTA ALGO MAS QUE `cliente.channel(topico)`. Con el topico
 * canonico aparecen tres comportamientos del cliente de Realtime que el
 * contador local tapaba. Los tres estan comprobados EJECUTANDO el cliente de
 * verdad (`@supabase/realtime-js` 2.110.7) contra un servidor en memoria, en
 * `reaccionesConElClienteReal.test.mts`:
 *
 * 1. `channel(topico)` devuelve EL MISMO objeto si ya hay un canal con ese
 *    topico. Dos pantallas de la misma emision —llega el aviso «Ana esta en
 *    vivo» estando ya dentro y se abre otra— comparten canal sin saberlo, y la
 *    primera que cierra se lo quita a la otra. Por eso aqui se CUENTAN los
 *    usuarios del canal y solo se suelta cuando no queda ninguno.
 *
 * 2. `send()` sobre un canal sin suscribir no falla: cae a una peticion HTTP
 *    por cada mensaje (y lo avisa como obsoleto). Esa via no respeta
 *    `self: false`, asi que la propia reaccion volveria duplicada al
 *    suscribirse, y una rafaga serian decenas de peticiones. Por eso `enviar`
 *    devuelve `false` sin tocar la red mientras no hay suscripcion, y quien
 *    decide que hacer con lo que no salio es `crearCanalDeReacciones`.
 *
 * 3. Si el canal lo cierra EL SERVIDOR (`phx_close`), el cliente lo quita y no
 *    vuelve a unirse: de una caida de red se recupera solo, de esto no. Sin
 *    hacer nada, la pantalla se quedaria sin reacciones hasta salir y volver a
 *    entrar. Por eso, con oyentes vivos, el canal se vuelve a montar tras una
 *    espera.
 *
 * `removeChannel` se llama EN EL MOMENTO, no en una promesa posterior. Con este
 * cliente quita el canal de su lista en la misma llamada, asi que quien abra
 * el mismo topico justo despues —un efecto de React que se vuelve a montar—
 * recibe un canal nuevo. Dejarlo para despues haria que recibiera el viejo,
 * que se cierra un instante mas tarde.
 *
 * `self: false` se conserva: quien pulsa ya pinto su reaccion en el mismo
 * gesto, y recibirla de vuelta dibujaria dos.
 */
export function crearTransporteDeRealtime(
  cliente: ClienteDeRealtime,
  opciones: {
    /** Programa algo. Devuelve como cancelarlo. Sin esto no se remonta. */
    programar?: (fn: () => void, ms: number) => () => void;
    evento?: string;
  } = {},
): TransporteDeBroadcast {
  const evento = opciones.evento ?? EVENTO_DE_REACCION;

  type Compartido = {
    /** El canal de ahora. Cambia si hay que volver a montarlo. */
    canal: CanalDeRealtime | null;
    oyentes: Set<OyenteDeTransporte>;
    estado: EstadoDeTransporte;
    /** Remontajes seguidos sin llegar a suscribirse. */
    intentos: number;
    cancelarRemontaje: (() => void) | null;
  };

  /** El canal vivo de cada topico. Como mucho uno. */
  const abiertos = new Map<string, Compartido>();

  function avisarEstado(compartido: Compartido, nuevo: EstadoDeTransporte): void {
    compartido.estado = nuevo;
    for (const oyente of [...compartido.oyentes]) oyente.alCambiarEstado(nuevo);
  }

  function enchufar(topico: string, compartido: Compartido): void {
    const canal = cliente.channel(topico, { config: { broadcast: { self: false } } });
    compartido.canal = canal;
    canal
      .on('broadcast', { event: evento }, (mensaje) => {
        // Un canal anterior que aun entrega algo ya no es el de este topico.
        if (compartido.canal !== canal) return;
        for (const oyente of [...compartido.oyentes]) oyente.alRecibir(mensaje?.payload);
      })
      .subscribe((estado) => {
        if (compartido.canal !== canal) return;
        if (estado === 'SUBSCRIBED') {
          compartido.intentos = 0;
          avisarEstado(compartido, 'suscrito');
          return;
        }
        if (estado !== 'CLOSED') {
          // Error o tiempo agotado: el cliente vuelve a unirse por su cuenta.
          avisarEstado(compartido, 'caido');
          return;
        }
        avisarEstado(compartido, 'cerrado');
        remontar(topico, compartido);
      });
  }

  /** El servidor cerro el canal y sigue habiendo quien lo usa: se monta otro. */
  function remontar(topico: string, compartido: Compartido): void {
    if (!opciones.programar) return;
    if (abiertos.get(topico) !== compartido || compartido.oyentes.size === 0) return;
    if (compartido.cancelarRemontaje) return;
    const espera = Math.min(
      ESPERA_DE_REMONTAJE_MS * 2 ** compartido.intentos,
      ESPERA_MAXIMA_DE_REMONTAJE_MS,
    );
    compartido.intentos += 1;
    compartido.cancelarRemontaje = opciones.programar(() => {
      compartido.cancelarRemontaje = null;
      if (abiertos.get(topico) !== compartido || compartido.oyentes.size === 0) return;
      enchufar(topico, compartido);
    }, espera);
  }

  return {
    abrir(topico, oyente) {
      let cerrada = false;
      let compartido = abiertos.get(topico);
      if (!compartido) {
        compartido = { canal: null, oyentes: new Set(), estado: 'caido', intentos: 0, cancelarRemontaje: null };
        abiertos.set(topico, compartido);
        // El oyente entra ANTES de enchufar: asi no se pierde el primer aviso.
        compartido.oyentes.add(oyente);
        enchufar(topico, compartido);
      } else {
        compartido.oyentes.add(oyente);
        // Quien llega a un canal que ya estaba suscrito no va a recibir el
        // aviso: se le cuenta ahora.
        if (compartido.estado === 'suscrito') oyente.alCambiarEstado('suscrito');
      }
      const mio = compartido;

      return {
        enviar(carga) {
          const canal = mio.canal;
          if (cerrada || !canal || mio.estado !== 'suscrito') return false;
          void Promise.resolve()
            .then(() => canal.send({ type: 'broadcast', event: evento, payload: carga }))
            .catch(() => {
              // Un mensaje efimero que no sale no lo echa de menos nadie.
            });
          // `self: false` es por conexion, y dos pantallas del mismo proceso
          // comparten la suya: el servidor no se lo devolveria a la otra.
          for (const otro of [...mio.oyentes]) {
            if (otro !== oyente) otro.alRecibir(carga);
          }
          return true;
        },

        cerrar() {
          if (cerrada) return;
          cerrada = true;
          mio.oyentes.delete(oyente);
          if (mio.oyentes.size > 0) return;

          // Era el ultimo: se suelta el canal, ahora.
          if (abiertos.get(topico) === mio) abiertos.delete(topico);
          if (mio.cancelarRemontaje) {
            mio.cancelarRemontaje();
            mio.cancelarRemontaje = null;
          }
          const canal = mio.canal;
          mio.canal = null;
          if (!canal) return;
          try {
            void Promise.resolve(cliente.removeChannel(canal)).catch(() => {});
          } catch {
            // Soltar un canal que ya no estaba no es un error.
          }
        },
      };
    },
  };
}

/* ------------------------------------------------------------------------- *
 * EL CANAL DE REACCIONES. Lo que usa la pantalla.
 * ------------------------------------------------------------------------- */

/**
 * Contadores de diagnostico. SOLO NUMEROS: ni usuarios, ni emisiones, ni
 * contenido. Se quedan en el telefono; no se mandan a ningun sitio.
 */
export type DiagnosticoDeReacciones = {
  /** Mensajes de Broadcast entregados a la red. */
  enviados: number;
  /** Mensajes ajenos validos recibidos. */
  recibidos: number;
  /** Mensajes ajenos ignorados por deformes. */
  invalidos: number;
  /** Reacciones propias que no salieron por saturacion o por caducar. */
  descartados: number;
  /** Veces que el canal volvio despues de haberse caido. */
  reconexiones: number;
  /** El mayor numero de reacciones propias que llego a haber esperando. */
  colaMaxima: number;
  /** Las que esperan ahora mismo. Vuelve a cero. */
  pendientes: number;
};

export type CanalDeReacciones = {
  /**
   * Lanza una reaccion propia: sale por Broadcast (agrupada con las que la
   * sigan) y se apunta para el resumen.
   *
   * Devuelve enseguida y no lanza nunca. La animacion de quien reacciona no
   * puede depender de que llegue nada.
   */
  enviar: (tipo: TipoDeReaccion) => void;
  /** Las reacciones de LOS DEMAS, por lotes. Devuelve como dejar de escuchar. */
  alRecibir: (escuchar: (conteos: Partial<ConteoDeReacciones>) => void) => () => void;
  /** Cierra el canal y manda lo que quedara acumulado. Idempotente. */
  cerrar: () => void;
  diagnostico: () => DiagnosticoDeReacciones;
};

export type EntornoDeReacciones = {
  emisionId: string;
  /** `null` = no hay tiempo real (modo demo): se cuenta, pero no se reparte. */
  transporte: TransporteDeBroadcast | null;
  /** Manda el resumen al servidor. Devuelve sus totales si los trae. */
  resumir: (conteos: Partial<ConteoDeReacciones>) => Promise<ConteoDeReacciones | void>;
  /** Si un fallo del resumen significa «las reacciones estan cerradas». */
  esCierreDeReacciones: (error: unknown) => boolean;
  /** Cada cuanto se resume. */
  intervaloDeResumenMs: number;
  /** Programa algo. Devuelve como cancelarlo. */
  programar: (fn: () => void, ms: number) => () => void;
  ahora: () => number;
  /** Los totales que devolvio el servidor tras un resumen. */
  alResumir?: (totales: ConteoDeReacciones) => void;
};

/**
 * El canal efimero de reacciones de una emision.
 *
 * Junta las dos mitades que hacen que esto funcione: el Broadcast, que las
 * reparte entre quienes miran, y el acumulador, que cada
 * `intervaloDeResumenMs` manda al backend cuantas ha puesto esta persona. No
 * se escribe una fila por emoji.
 *
 * ANTES DE SUSCRIBIRSE no se envia nada: se guarda —pocas, y poco rato— y sale
 * junto en cuanto el canal confirma. Ver `crearTransporteDeRealtime` para por
 * que no se usa la via HTTP.
 *
 * Sin transporte sigue funcionando a medias, y es la degradacion correcta: no
 * se ven las reacciones de los demas —no hay por donde— pero las propias se
 * siguen contando en el servidor.
 */
export function crearCanalDeReacciones(entorno: EntornoDeReacciones): CanalDeReacciones {
  const escuchas = new Set<(conteos: Partial<ConteoDeReacciones>) => void>();
  let cerrado = false;

  /* --- Hacia la red --- */
  let suscrito = false;
  let seSuscribioAntes = false;
  let pendiente: Partial<ConteoDeReacciones> = {};
  let cuantasPendientes = 0;
  /** Cuando entro la mas antigua de las que esperan. */
  let pendienteDesde = 0;
  let cancelarVentana: (() => void) | null = null;

  /* --- Hacia el servidor --- */
  let acumulado: Partial<ConteoDeReacciones> = {};
  let cancelarResumen: (() => void) | null = null;
  /*
    Cuando el servidor dice que las reacciones estan cerradas se deja de
    acumular. Sin esto, cada intervalo repetiria la misma peticion condenada al
    409 durante todo el rato que quede alguien con la pantalla abierta.
  */
  let admiteReacciones = true;

  const cuenta = { enviados: 0, recibidos: 0, invalidos: 0, descartados: 0, reconexiones: 0, colaMaxima: 0 };

  function vaciarPendiente(): void {
    pendiente = {};
    cuantasPendientes = 0;
  }

  /** Saca a la red lo que cabe en un mensaje y abre la ventana siguiente. */
  function despachar(): void {
    if (cerrado || !conexion || !suscrito || cuantasPendientes === 0) return;

    if (entorno.ahora() - pendienteDesde > CADUCIDAD_DE_PENDIENTES_MS) {
      cuenta.descartados += cuantasPendientes;
      vaciarPendiente();
      return;
    }

    const lote: Partial<ConteoDeReacciones> = {};
    const resto: Partial<ConteoDeReacciones> = {};
    let quedan = 0;
    for (const tipo of REACCIONES) {
      const cuantas = pendiente[tipo] ?? 0;
      if (cuantas <= 0) continue;
      const salen = Math.min(cuantas, MAXIMO_POR_MENSAJE);
      lote[tipo] = salen;
      if (cuantas > salen) {
        resto[tipo] = cuantas - salen;
        quedan += cuantas - salen;
      }
    }

    const carga: CargaDeReacciones = { v: 1, conteos: lote };
    // Si la red no lo acepta, sigue esperando: NO se da por enviado, y por eso
    // mismo no puede salir dos veces.
    if (!conexion.enviar(carga)) return;

    cuenta.enviados += 1;
    pendiente = resto;
    cuantasPendientes = quedan;
    if (quedan > 0) pendienteDesde = entorno.ahora();
    abrirVentana();
  }

  function abrirVentana(): void {
    if (cancelarVentana || cerrado) return;
    cancelarVentana = entorno.programar(() => {
      cancelarVentana = null;
      despachar();
    }, VENTANA_DE_ENVIO_MS);
  }

  /*
    `let`, y declarada ANTES de abrir: un transporte que ya estaba suscrito
    avisa del estado dentro de la propia llamada a `abrir`, y `despachar` lee
    esta variable. Con `const` eso seria leerla antes de que exista.
  */
  let conexion: ConexionDeBroadcast | null = null;
  conexion = entorno.transporte
    ? entorno.transporte.abrir(topicoDeReacciones(entorno.emisionId), {
        alRecibir(carga) {
          if (cerrado) return;
          const conteos = leerReaccionRemota(carga);
          if (!conteos) {
            cuenta.invalidos += 1;
            return;
          }
          cuenta.recibidos += 1;
          for (const escuchar of [...escuchas]) {
            try {
              escuchar(conteos);
            } catch {
              // Un oyente que revienta no puede tumbar la entrega a los demas,
              // ni salir hacia el cliente de Realtime.
            }
          }
        },
        alCambiarEstado(estado) {
          if (cerrado) return;
          const antes = suscrito;
          suscrito = estado === 'suscrito';
          if (!suscrito || antes) return;
          if (seSuscribioAntes) cuenta.reconexiones += 1;
          seSuscribioAntes = true;
          // Lo que se pulso mientras no habia canal sale ahora, una vez.
          if (!cancelarVentana) despachar();
        },
      })
    : null;

  async function resumir(): Promise<void> {
    if (cancelarResumen) {
      cancelarResumen();
      cancelarResumen = null;
    }
    const lote = acotarResumen(acumulado);
    acumulado = {};
    if (cuantasHay(lote) === 0) return;

    try {
      const totales = await entorno.resumir(lote);
      if (totales && !cerrado) entorno.alResumir?.(totales);
    } catch (error) {
      if (entorno.esCierreDeReacciones(error)) admiteReacciones = false;
      /*
        Lo demas se tira, y a proposito. Una reaccion perdida no la echa de
        menos nadie: el contador es agregado y la siguiente rafaga lo corrige.
        Reintentar significaria guardar el lote y mandarlo doble mas tarde,
        inflando un numero por un fallo de red.
      */
    }
  }

  function programarResumen(): void {
    if (cancelarResumen || cerrado) return;
    cancelarResumen = entorno.programar(() => {
      cancelarResumen = null;
      void resumir();
    }, entorno.intervaloDeResumenMs);
  }

  return {
    enviar(tipo) {
      if (cerrado || !esReaccion(tipo)) return;

      // El total que se guarda. No depende de que haya canal.
      if (admiteReacciones) {
        acumulado[tipo] = (acumulado[tipo] ?? 0) + 1;
        programarResumen();
      }

      // Lo que ven los demas.
      if (!conexion) return;
      if (cuantasPendientes >= TOPE_DE_PENDIENTES) {
        cuenta.descartados += 1;
        return;
      }
      if (cuantasPendientes === 0) pendienteDesde = entorno.ahora();
      pendiente[tipo] = (pendiente[tipo] ?? 0) + 1;
      cuantasPendientes += 1;
      if (cuantasPendientes > cuenta.colaMaxima) cuenta.colaMaxima = cuantasPendientes;
      // Sin ventana abierta, sale ya: un toque suelto no espera a nadie.
      if (!cancelarVentana) despachar();
    },

    alRecibir(escuchar) {
      if (cerrado) return () => {};
      escuchas.add(escuchar);
      return () => {
        escuchas.delete(escuchar);
      };
    },

    cerrar() {
      if (cerrado) return;
      // Lo acumulado sale ANTES de marcar el cierre: si no, salir de la
      // pantalla tiraria los ultimos segundos de reacciones, que son justo los
      // de cuando la persona estaba mas enganchada.
      void resumir();
      cerrado = true;
      escuchas.clear();
      if (cancelarVentana) {
        cancelarVentana();
        cancelarVentana = null;
      }
      // Las que esperaban a salir se pierden: eran animaciones.
      vaciarPendiente();
      conexion?.cerrar();
    },

    diagnostico() {
      return { ...cuenta, pendientes: cuantasPendientes };
    },
  };
}
