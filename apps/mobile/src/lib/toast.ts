import type { Feather } from '@expo/vector-icons';

export type ToastRequest = {
  message: string;
  icon?: keyof typeof Feather.glyphMap;
  /**
   * Una accion opcional dentro del aviso: «Ver lista», «Deshacer»…
   *
   * Es OPCIONAL a proposito. Los avisos que ya existen —publicado, eliminado,
   * copiado— no llevan accion y no cambian en nada: siguen apareciendo y
   * yendose solos.
   */
  accion?: {
    etiqueta: string;
    alPulsar: () => void;
  };
};

/**
 * Puente con el toast de la app.
 *
 * Mismo motivo que en `confirm`: se llama desde funciones sueltas (acciones del
 * store, repositorios), no solo desde componentes, asi que no puede apoyarse en
 * un contexto de React. `ToastHost` se registra aqui al montarse.
 */
let present: ((request: ToastRequest) => void) | null = null;

export function registerToastHost(fn: ((request: ToastRequest) => void) | null): void {
  present = fn;
}

/**
 * Confirmacion de exito: aparece y se va sola.
 *
 * Para lo que SALE BIEN (publicado, guardado, eliminado). Un dialogo obligaria
 * a descartar algo que el usuario ya da por hecho; el toast informa sin
 * interrumpir. Los errores y las decisiones siguen usando `notify` y `confirm`.
 *
 * Si el host aun no esta montado no pasa nada: una confirmacion de exito no es
 * critica y no merece un dialogo de emergencia.
 */
export function toast(message: string, icon: keyof typeof Feather.glyphMap = 'check-circle'): void {
  present?.({ message, icon });
}

/**
 * Confirmacion con una salida a donde acaba de pasar algo.
 *
 * POR QUE SEPARADA DE `toast`. Guardar una publicacion sin decir nada obligaba
 * a ir al perfil y mirar la lista para saber si habia funcionado. Y saber que
 * funciono no basta: lo util es poder ir a verlo. Eso es una accion, no un
 * texto mas largo.
 *
 * Se deja `toast` intacta —treinta y tantas llamadas— y se anade esta al lado,
 * en el MISMO sistema: un solo host, un solo componente, la misma animacion y
 * la misma desaparicion automatica. Nada de un segundo Snackbar en paralelo.
 *
 * La accion no impide que el aviso se vaya solo: si no se pulsa, desaparece
 * como cualquier otro. Un aviso que espera a que lo atiendan es un dialogo.
 */
export function toastConAccion(
  message: string,
  accion: { etiqueta: string; alPulsar: () => void },
  icon: keyof typeof Feather.glyphMap = 'check-circle',
): void {
  present?.({ message, icon, accion });
}
