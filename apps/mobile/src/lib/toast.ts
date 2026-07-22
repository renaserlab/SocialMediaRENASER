import type { Feather } from '@expo/vector-icons';

export type ToastRequest = {
  message: string;
  icon?: keyof typeof Feather.glyphMap;
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
