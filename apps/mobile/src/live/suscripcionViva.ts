/**
 * UNA SUSCRIPCION QUE NO SE QUEDA MUERTA.
 *
 * El cliente de Supabase Realtime se recupera solo de una caida de red: vuelve
 * a unirse al canal y avisa otra vez con `SUBSCRIBED`. De lo que NO se
 * recupera es de que el SERVIDOR cierre el canal (`phx_close`): lo quita de su
 * lista y no vuelve a intentarlo. Comprobado ejecutando el cliente de verdad
 * (2.110.7) en `reaccionesConElClienteReal.test.mts`.
 *
 * Para el chat de un directo eso era quedarse en «Reconectando…» para siempre,
 * con la pantalla abierta y sin recibir un solo mensaje mas.
 *
 * Esto envuelve una suscripcion: si se cierra sin que la haya cerrado la
 * aplicacion, la vuelve a abrir tras una espera que se dobla en cada intento
 * seguido. No decide nada mas.
 *
 * NO IMPORTA NADA: se ejecuta con `node --test`.
 */

/** La primera espera antes de volver a abrir. */
export const ESPERA_DE_REENGANCHE_MS = 2_000;

/** El tope. Un servidor que cierra una y otra vez no se aporrea. */
export const ESPERA_MAXIMA_DE_REENGANCHE_MS = 30_000;

export type EstadoDeSuscripcion = 'suscrito' | 'caido';

export function mantenerSuscripcion(entorno: {
  /**
   * Abre el canal y se suscribe. `alCambiar` recibe los estados tal y como
   * los da el cliente (`SUBSCRIBED`, `CHANNEL_ERROR`, `TIMED_OUT`, `CLOSED`).
   * Devuelve como cerrarlo. Se llama otra vez en cada reenganche: tiene que
   * crear un canal NUEVO cada vez.
   */
  abrir: (alCambiar: (estado: string) => void) => () => void;
  /** Programa algo. Devuelve como cancelarlo. */
  programar: (fn: () => void, ms: number) => () => void;
  alCambiar?: (estado: EstadoDeSuscripcion) => void;
}): () => void {
  let vigente = true;
  let cerrarActual: (() => void) | null = null;
  let cancelarEspera: (() => void) | null = null;
  let intentos = 0;
  /** Cada apertura lleva numero: los avisos de una anterior no cuentan. */
  let generacion = 0;

  function reenganchar(): void {
    if (!vigente || cancelarEspera) return;
    const espera = Math.min(
      ESPERA_DE_REENGANCHE_MS * 2 ** intentos,
      ESPERA_MAXIMA_DE_REENGANCHE_MS,
    );
    intentos += 1;
    cancelarEspera = entorno.programar(() => {
      cancelarEspera = null;
      montar();
    }, espera);
  }

  function montar(): void {
    if (!vigente) return;
    const mia = (generacion += 1);
    const anterior = cerrarActual;
    cerrarActual = null;
    // El canal que cerro el servidor se suelta del todo antes de abrir otro.
    anterior?.();
    cerrarActual = entorno.abrir((estado) => {
      if (!vigente || mia !== generacion) return;
      if (estado === 'SUBSCRIBED') {
        intentos = 0;
        entorno.alCambiar?.('suscrito');
        return;
      }
      entorno.alCambiar?.('caido');
      // De un error o de un tiempo agotado se recupera el cliente solo. De un
      // cierre, no.
      if (estado === 'CLOSED') reenganchar();
    });
  }

  montar();

  return () => {
    if (!vigente) return;
    vigente = false;
    generacion += 1;
    if (cancelarEspera) {
      cancelarEspera();
      cancelarEspera = null;
    }
    const actual = cerrarActual;
    cerrarActual = null;
    actual?.();
  };
}
