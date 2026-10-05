import type { Feather } from '@expo/vector-icons';

import type { TipoDeAviso } from './colaDeAvisos';

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
  /**
   * De que clase es. Decide el icono por defecto, cuanto dura y como convive
   * con los demas (ver `colaDeAvisos`). Sin el, es una confirmacion de exito:
   * lo que eran todos antes de existir los tipos.
   */
  tipo?: TipoDeAviso;
  /** Una linea en negrita encima del mensaje: quien escribe, de que va. */
  titulo?: string;
  /** La foto de quien lo origina, en vez del icono. Solo en notificaciones. */
  avatarUrl?: string | null;
  /** Tocar el aviso entero (no la accion): abrir aquello de lo que habla. */
  alTocar?: () => void;
  /**
   * Lo que hace que dos avisos sean el mismo. Sin ella, tipo y texto. Las
   * notificaciones mandan la suya (la conversacion, la publicacion) para que
   * cinco seguidas de lo mismo sean un aviso y no cinco.
   */
  clave?: string;
  /** Milisegundos en pantalla, si hay motivo para no usar los del tipo. */
  duracion?: number;
};

/**
 * Puente con el toast de la app.
 *
 * Mismo motivo que en `confirm`: se llama desde funciones sueltas (acciones del
 * store, repositorios), no solo desde componentes, asi que no puede apoyarse en
 * un contexto de React. `ToastHost` se registra aqui al montarse.
 */
let present: ((request: ToastRequest) => void) | null = null;
let retirar: ((esDeLaClave: (clave: string) => boolean) => void) | null = null;

/*
  LAS NOTIFICACIONES PEDIDAS ANTES DE QUE EXISTA EL HOST SE GUARDAN.

  El host se monta cuando la aplicación termina de arrancar (sesión leída,
  fuentes cargadas). Lo que se pide al abrir —«tienes 3 mensajes sin leer»—
  sale de una petición que puede contestar ANTES de eso, y entonces `present`
  todavía es `null`: el aviso se descartaba sin dejar rastro. Visto el
  05/10/2026 al comprobar el aviso de «sin leer» del arranque: las tres
  peticiones salían y en pantalla no aparecía nada.

  SOLO LAS NOTIFICACIONES, y pocas. Una confirmación de éxito que llega sin
  host sigue sin merecer nada: no es crítica y enseñarla tarde sería peor. Y
  con tope, para que un arranque atascado no acumule una cola.
*/
const EN_ESPERA_COMO_MUCHO = 4;
let enEspera: ToastRequest[] = [];

export function registerToastHost(
  fn: ((request: ToastRequest) => void) | null,
  quitar: ((esDeLaClave: (clave: string) => boolean) => void) | null = null,
): void {
  present = fn;
  retirar = quitar;
  if (!fn || enEspera.length === 0) return;
  const guardadas = enEspera;
  enEspera = [];
  for (const peticion of guardadas) fn(peticion);
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

/**
 * Cualquier aviso transitorio, con todos sus campos.
 *
 * Es la puerta completa de la misma autoridad: `toast` y `toastConAccion` son
 * dos atajos suyos. Se usa para lo que no es una simple confirmacion —un error
 * de red, una advertencia, una notificacion que llega con la aplicacion
 * abierta—.
 *
 * NO PARA ERRORES DE FORMULARIO. Lo que la persona tiene que corregir en un
 * campo se dice junto al campo, que es donde va a mirar; un aviso que se va
 * solo le quitaria la explicacion antes de que termine de arreglarlo.
 */
export function avisar(peticion: ToastRequest): void {
  if (present) {
    present(peticion);
    return;
  }
  if (peticion.tipo !== 'notificacion') return;
  // La misma clave es el mismo aviso: se queda la versión más reciente.
  enEspera = [
    ...enEspera.filter((otra) => !peticion.clave || otra.clave !== peticion.clave),
    peticion,
  ].slice(-EN_ESPERA_COMO_MUCHO);
}

/** Algo no salio, y no hay un campo donde decirlo: la red, el servidor. */
export function toastDeError(message: string): void {
  present?.({ message, tipo: 'error' });
}

/**
 * Retira los avisos que ya no vienen a cuento.
 *
 * El caso: llega el aviso de un mensaje y la persona abre esa conversacion
 * antes de que se vaya. Dejarlo encima seria anunciarle lo que ya esta leyendo.
 */
export function retirarAvisosDe(esDeLaClave: (clave: string) => boolean): void {
  // También lo que aún espera al host: abrir la conversación lo deja sin sentido.
  enEspera = enEspera.filter((peticion) => !peticion.clave || !esDeLaClave(peticion.clave));
  retirar?.(esDeLaClave);
}
