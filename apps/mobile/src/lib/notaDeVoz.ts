/**
 * Las reglas de una nota de voz, sin tocar el micrófono ni la pantalla.
 *
 * POR QUE VIVEN APARTE. Todo lo demás de grabar es llamar al sistema —pedir
 * permiso, arrancar el grabador, escribir un fichero— y eso no se puede probar
 * sin un teléfono. Lo que sí tiene reglas, y reglas que se pueden equivocar en
 * silencio, es DECIDIR QUÉ HACER con lo grabado. Eso está aquí y tiene pruebas.
 *
 * Es el mismo reparto que ya hace `estadoDePermiso.ts` con `permisos.ts`.
 */

/**
 * Lo que tiene que durar una pulsación antes de que empiece a grabar.
 *
 * ES LA DIFERENCIA ENTRE «mantener pulsado» Y «tocar». Sin este umbral, rozar
 * el micrófono al ir a escribir dejaba una grabación de 200 ms empezada, con su
 * aviso rojo y su vibración: la aplicación parecía tener vida propia. El gesto
 * definido es mantener pulsado, así que un toque simple NO puede grabar.
 *
 * 250 ms es lo que usan los chats que ya conoce todo el mundo: suficiente para
 * descartar el roce, y no tanto como para que parezca que el botón no responde.
 */
export const MS_PARA_EMPEZAR = 250;

/**
 * Lo mínimo que tiene que durar el audio para que valga la pena mandarlo.
 *
 * Distinto de lo anterior: aquello mide el DEDO antes de grabar, esto mide el
 * AUDIO ya grabado. Alguien que mantiene pulsado y suelta enseguida no quería
 * mandar nada, y una burbuja de medio segundo en la que solo se oye el roce del
 * dedo es ruido para quien la recibe — que además tiene que pulsarla para
 * descubrir que no dice nada.
 */
export const MIN_DURACION_S = 1;

/**
 * Lo máximo. EL MISMO NUMERO QUE `audio.MAX_DURACION_S` DEL BACKEND, y tiene
 * que seguir siéndolo: si aquí fuera mayor, la nota se grabaría entera, se
 * subiría entera y el servidor la rechazaría al final, después de gastar los
 * datos de quien la mandó.
 *
 * Cinco minutos no es un límite técnico sino de lo que es razonable escuchar en
 * un chat: más allá de eso lo que se quiere mandar es un archivo, y para eso ya
 * está el botón de adjuntar.
 */
export const MAX_DURACION_S = 5 * 60;

/** Qué hacer con lo que se acaba de grabar. */
export type DesenlaceDeGrabacion =
  /** Se manda. */
  | 'enviar'
  /** Se tira sin decir nada: la persona la canceló a propósito. */
  | 'descartar'
  /** Se tira Y se explica: fue un roce, no una nota. */
  | 'demasiado-corta';

export type Grabacion = {
  /** Duración del audio en milisegundos, según el grabador. */
  ms: number;
  /** La persona la canceló antes de soltar. */
  cancelada: boolean;
};

/**
 * Qué hacer al soltar el dedo.
 *
 * EL ORDEN DE LAS PREGUNTAS IMPORTA. Cancelar gana siempre, incluso sobre una
 * grabación larga y buena: quien desliza para cancelar ya ha decidido, y
 * mandarla igual porque «duraba lo suficiente» sería ignorarle. Y una
 * cancelación no se explica —no hay nada que explicar, fue a propósito—
 * mientras que un roce sí, porque quien lo hizo no sabe por qué no ha pasado
 * nada.
 */
export function decidirDesenlace({ ms, cancelada }: Grabacion): DesenlaceDeGrabacion {
  if (cancelada) return 'descartar';
  if (!Number.isFinite(ms) || ms < MIN_DURACION_S * 1000) return 'demasiado-corta';
  return 'enviar';
}

/**
 * Los segundos que se mandan al backend, redondeados a una décima.
 *
 * SE REDONDEA HACIA ABAJO y no al más cercano, a propósito: el backend rechaza
 * lo que pase de `MAX_DURACION_S`, así que una nota de 300,04 s redondeada
 * hacia arriba se convertiría en 300,1 y podría cruzar el límite por una
 * décima que nadie ha grabado. Perder una centésima no se nota; perder la nota
 * entera, sí.
 */
export function duracionEnSegundos(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.floor(ms / 100) / 10;
}

/**
 * `1:04`. El reloj que se ve mientras se graba y en la burbuja.
 *
 * Los segundos van siempre con dos cifras: sin eso, el contador salta de `0:9`
 * a `0:10` y el ancho del texto cambia, así que la fila entera da un tirón cada
 * diez segundos.
 */
export function formatearDuracion(segundos: number): string {
  const seguro = Number.isFinite(segundos) ? Math.max(0, segundos) : 0;
  const minutos = Math.floor(seguro / 60);
  const resto = Math.floor(seguro % 60);
  return `${minutos}:${resto.toString().padStart(2, '0')}`;
}

/**
 * Si ya se ha llegado al tope y hay que parar solo.
 *
 * Parar por las buenas al llegar al máximo es mejor que dejar grabar y
 * rechazarlo después: quien está hablando ve que la grabación se detiene y
 * decide si la manda, en vez de descubrir al soltar que ha perdido lo dicho.
 */
export function llegoAlTope(ms: number): boolean {
  return Number.isFinite(ms) && ms >= MAX_DURACION_S * 1000;
}
