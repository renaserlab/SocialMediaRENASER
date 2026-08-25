/**
 * El ritmo del cliente dentro de una emision: cuantos mensajes se dejan enviar
 * y cada cuanto se vacia el acumulador de reacciones.
 *
 * ESTO ES COMODIDAD, NO SEGURIDAD. El limite que cuenta vive en el SERVIDOR
 * —responde 409 con `live_chat_rate_limited` y `live_reactions_rate_limited`— y
 * es el unico que protege nada: lo de aqui se desactiva cambiando una constante
 * y se salta entero hablando con la API sin pasar por la aplicacion. Nunca se
 * debe razonar como si esto frenara a alguien que quiere abusar.
 *
 * Lo que si arregla estar tambien aqui:
 *
 *   - El freno se nota ANTES de escribir. Sin esto, quien escribe rapido pierde
 *     el mensaje contra un 409 que llega medio segundo despues, cuando el campo
 *     ya se ha vaciado y el texto se ha ido.
 *   - Las reacciones no salen una a una. Un directo animado son decenas de
 *     toques por segundo; una peticion por toque convertiria el chat en una
 *     tormenta de red y el servidor las rechazaria en bloque. Viajan por
 *     Broadcast entre clientes y al backend solo va el RESUMEN acumulado.
 *
 * Esta separado del servicio para poder probar la politica sin montar un canal
 * de Realtime ni un temporizador, igual que `ritmoDeProgreso.ts`.
 */

/**
 * Cuantos mensajes se dejan enviar dentro de la ventana.
 *
 * Cinco es holgado para una conversacion normal —nadie escribe cinco frases en
 * diez segundos sin querer— y corta en seco el pulsar «enviar» repetido.
 */
export const MENSAJES_POR_VENTANA = 5;

/** Ventana movil sobre la que se cuentan esos mensajes. */
export const VENTANA_DE_MENSAJES_MS = 10_000;

/**
 * Cada cuanto se manda al backend el resumen de reacciones propias.
 *
 * Cinco segundos juntan una rafaga entera en UNA peticion y son lo bastante
 * poco para que cerrar la pantalla no pierda casi nada (al salir se vacia lo
 * pendiente de todas formas). Bajarlo acerca el resumen al limite de
 * reacciones del servidor sin ganar nada: los totales son un contador, no un
 * dato que nadie este mirando al segundo.
 */
export const INTERVALO_DE_RESUMEN_MS = 5_000;

/**
 * Los envios que siguen contando ahora mismo.
 *
 * Espera la lista en orden cronologico, que es como la produce
 * `registrarEnvio`.
 */
export function enviosVigentes(envios: readonly number[], ahora: number): number[] {
  return envios.filter((momento) => ahora - momento < VENTANA_DE_MENSAJES_MS);
}

/** Si cabe un mensaje mas en la ventana. */
export function puedeEnviarMensaje(envios: readonly number[], ahora: number): boolean {
  return enviosVigentes(envios, ahora).length < MENSAJES_POR_VENTANA;
}

/**
 * Apunta un envio y devuelve la lista ya podada.
 *
 * Devuelve una lista nueva en vez de modificar la recibida: asi quien llama
 * puede guardarla en un estado de React sin sorpresas, y la funcion se puede
 * probar sin montar nada.
 */
export function registrarEnvio(envios: readonly number[], ahora: number): number[] {
  return [...enviosVigentes(envios, ahora), ahora];
}

/**
 * Cuanto falta para poder volver a escribir, en milisegundos.
 *
 * Sirve para que el aviso diga «espera 4 s» en vez de «vas demasiado rapido» a
 * secas: sin el numero, quien lo lee no sabe si son dos segundos o un minuto y
 * lo unico que puede hacer es seguir pulsando.
 */
export function esperaRestanteMs(envios: readonly number[], ahora: number): number {
  const vigentes = enviosVigentes(envios, ahora);
  if (vigentes.length < MENSAJES_POR_VENTANA) return 0;
  // El hueco se abre cuando CADUCA el mas antiguo de los que ocupan la ventana,
  // no el mas antiguo de todos: si hay de sobra, el que libera sitio es el que
  // esta justo en el borde del cupo.
  const queLibera = vigentes[vigentes.length - MENSAJES_POR_VENTANA];
  if (queLibera === undefined) return 0;
  return Math.max(0, VENTANA_DE_MENSAJES_MS - (ahora - queLibera));
}

/** Si toca mandar ya el resumen de reacciones acumuladas. */
export function debeResumirReacciones(ultimoResumen: number, ahora: number): boolean {
  return ahora - ultimoResumen >= INTERVALO_DE_RESUMEN_MS;
}
