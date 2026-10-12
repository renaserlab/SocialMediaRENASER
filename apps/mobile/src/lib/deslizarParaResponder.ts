/**
 * Deslizar un mensaje para responderlo, como en cualquier chat.
 *
 * Pedido el 12/10/2026: «que responder mensajes sea deslizando el dedo a la
 * izquierda o derecha». Hasta entonces responder exigía mantener presionado
 * el mensaje y elegir «Responder» en un menú: dos pasos para lo que más se
 * hace en un grupo.
 *
 * Aquí están los números y las cuentas del gesto: cuánto sigue la burbuja al
 * dedo, cuándo cuenta como «quiero responder» y cómo vuelve a su sitio. El
 * gesto en sí —y lo que se mueve— está en
 * `components/chat/DeslizarParaResponder.tsx`.
 *
 * Sin importaciones, a propósito: se prueba con `node --test` tal cual.
 */

/**
 * Cuánto hay que mover el dedo de lado para que el gesto empiece.
 *
 * Menos y se confundiría con un toque o con el temblor de quien desplaza la
 * lista; más y el gesto se sentiría duro.
 */
export const ARRANQUE = 14;

/**
 * Cuánto se puede ir el dedo en vertical antes de que el gesto se rinda.
 *
 * Es lo que deja la lista en paz: quien sube o baja por el chat nunca mueve
 * una burbuja de lado.
 */
export const TOLERANCIA_VERTICAL = 12;

/** A partir de cuánto desplazamiento soltar significa «responder». */
export const UMBRAL = 56;

/** Lo más lejos que llega la burbuja, por mucho que siga el dedo. */
export const TOPE = 84;

/** Lo que la burbuja avanza por cada punto que avanza el dedo. */
const AGARRE = 0.7;

/** Milisegundos que tarda la burbuja en volver a su sitio al soltarla. */
export const DURACION_DE_VUELTA = 160;

/**
 * Dónde queda la burbuja para un dedo que se ha movido `dx` puntos.
 *
 * Sigue al dedo, pero con freno y con tope: se nota que se está tirando de
 * algo que quiere volver, y un tirón largo no saca la burbuja de la pantalla.
 * Vale para los dos lados: el signo es el del dedo.
 */
export function desplazamientoDe(dx: number): number {
  if (!Number.isFinite(dx) || dx === 0) return 0;
  const lejos = Math.min(TOPE, Math.abs(dx) * AGARRE);
  return dx < 0 ? -lejos : lejos;
}

/** Si, soltando ahora, se responde. */
export function pasaElUmbral(dx: number): boolean {
  return Math.abs(desplazamientoDe(dx)) >= UMBRAL;
}

/**
 * Cuánto se ve la flecha de responder, de 0 a 1.
 *
 * Aparece según se tira y está entera justo cuando soltar ya responde: es lo
 * que le dice a la persona «ya, suelta».
 */
export function avanceDeLaFlecha(dx: number): number {
  return Math.min(1, Math.abs(desplazamientoDe(dx)) / UMBRAL);
}

/** El tamaño de la flecha: crece un poco mientras aparece. */
export function escalaDeLaFlecha(dx: number): number {
  return 0.6 + 0.4 * avanceDeLaFlecha(dx);
}

/**
 * Dónde está la burbuja mientras vuelve: sale de `desde` y llega a 0.
 *
 * `transcurrido` son los milisegundos desde que se soltó. Frena al llegar,
 * sin rebote: es una burbuja que vuelve a su sitio, no un muelle.
 */
export function posicionDeVuelta(desde: number, transcurrido: number): number {
  if (!Number.isFinite(desde) || !Number.isFinite(transcurrido)) return 0;
  const t = Math.min(1, Math.max(0, transcurrido / DURACION_DE_VUELTA));
  // Cero limpio al llegar: desde la izquierda la cuenta daría «menos cero».
  if (t >= 1) return 0;
  const frenado = 1 - (1 - t) ** 3;
  return desde * (1 - frenado);
}

type MensajeMinimo = {
  /** `enviando` o `error`: todavía no existe para el servidor. */
  estado?: string | null;
  eliminado?: boolean;
  /** El registro de una sesión: una tarjeta, no un mensaje. */
  esSesion?: boolean;
};

/**
 * Si a este mensaje se le puede responder deslizando.
 *
 * LO MISMO QUE DECIDE EL MENÚ. Deslizar es otro camino a «Responder», no una
 * función nueva: si el servidor todavía no sabe guardar respuestas, o el
 * mensaje aún no ha llegado a él, o se borró, el gesto no existe. Un gesto
 * que cita un mensaje que luego no se puede enviar sería un botón muerto.
 */
export function sePuedeResponder(mensaje: MensajeMinimo, conRespuestas: boolean): boolean {
  if (!conRespuestas) return false;
  return !mensaje.estado && !mensaje.eliminado && !mensaje.esSesion;
}
