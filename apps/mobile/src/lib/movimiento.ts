/**
 * El movimiento de la aplicación, en un solo sitio.
 *
 * POR QUÉ EXISTE. Cada pantalla animaba —o no animaba— por su cuenta: un toast
 * con muelle, un botón que solo bajaba la opacidad, una hoja que entraba en 300
 * y otra en 250. El resultado no era feo en ninguna pantalla y era incoherente
 * entre todas. Aquí están los cuatro tiempos, el muelle y las escalas, y los
 * componentes compartidos (`Pulsable`, `Button`, `Chip`, el toast…) los leen
 * de aquí.
 *
 * NO ES UN SISTEMA DE DISEÑO. Son números con nombre. Lo que no esté aquí no
 * necesita animarse.
 *
 * SIN REACT Y SIN REACT NATIVE, a propósito: las pruebas de este proyecto
 * corren con el runner de Node y no pueden montar componentes. Lo que se
 * decide —cuánto dura, cuánto encoge, qué se hace con «reducir movimiento»—
 * se prueba aquí; lo que se dibuja, en el componente.
 */

/** Milisegundos. Cuatro escalones y ninguno más. */
export const DURACION = {
  /** El dedo baja o sube: tiene que notarse sin llegar a verse. */
  toque: 100,
  /** Una respuesta corta: un icono que cambia, un contador. */
  breve: 160,
  /** Una transición normal: una pestaña, un acordeón. */
  normal: 230,
  /** Algo grande que entra en pantalla: una hoja, un aviso. */
  panel: 300,
} as const;

/**
 * Lo que encoge un control mientras está pulsado.
 *
 * Cuanto más grande es la superficie, menos encoge: un 3 % en un botón de 300
 * puntos son 9 puntos y se ve; en un icono de 24 no se vería nada.
 */
export const ESCALA_AL_PULSAR = {
  /** Botones, filas y tarjetas. */
  superficie: 0.97,
  /** Chips y segmentos. */
  chip: 0.96,
  /** Iconos sueltos. */
  icono: 0.9,
} as const;

/** Hasta dónde sube un icono al encenderse antes de volver a su tamaño. */
export const ESCALA_AL_ENCENDER = 1.22;

/**
 * El muelle. Suave: llega, se pasa apenas y se asienta. Un rebote que se nota
 * es un adorno, y repetido en cada toque cansa.
 */
export const MUELLE = { damping: 16, stiffness: 240, mass: 0.8 } as const;

/** El muelle de lo que entra desde fuera (avisos, hojas): algo más de cuerpo. */
export const MUELLE_DE_PANEL = { damping: 20, stiffness: 210, mass: 0.9 } as const;

/** Lo que se desplaza algo al entrar. Poco: acompaña a la opacidad, no la sustituye. */
export const DESPLAZAMIENTO_DE_ENTRADA = 8;

/**
 * La salida dura menos que la entrada.
 *
 * Lo que entra se está presentando; lo que sale ya se ha leído y solo estorba.
 */
export function duracionDeSalida(entrada: number): number {
  return Math.round(entrada * 0.7);
}

/**
 * Cuánto dura algo según si la persona ha pedido reducir el movimiento.
 *
 * Con la reducción activa el cambio sigue ocurriendo —el estado no se pierde—
 * pero de golpe: cero milisegundos.
 */
export function duracionEfectiva(duracion: number, reducir: boolean): number {
  return reducir ? 0 : duracion;
}

/**
 * La escala de un control pulsado.
 *
 * `presion` va de 0 (suelto) a 1 (pulsado). Con «reducir movimiento» no
 * encoge: el toque se sigue viendo porque la opacidad sí cambia.
 */
export function escalaPulsada(presion: number, escala: number, reducir: boolean): number {
  'worklet';
  if (reducir) return 1;
  return 1 - presion * (1 - escala);
}

/** La opacidad de un control pulsado. Esta sí se conserva al reducir movimiento. */
export function opacidadPulsada(presion: number, minima: number): number {
  'worklet';
  return 1 - presion * (1 - minima);
}

/**
 * El retraso de cada elemento de una lista que entra en cascada.
 *
 * Con tope: una lista de cuarenta no puede tardar dos segundos en terminar de
 * aparecer. A partir del sexto entran todos a la vez.
 */
export function retrasoEnCascada(indice: number, paso = 40, tope = 6): number {
  if (indice <= 0) return 0;
  return Math.min(indice, tope) * paso;
}
