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
 * Lo que se mueve a los lados un campo cuando rechaza lo escrito.
 *
 * Poco: es un «no» con la cabeza, no un susto. Lleva la vista al campo que hay
 * que corregir; el motivo lo dice el texto de debajo.
 */
export const AMPLITUD_DE_SACUDIDA = 6;

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

// ---------------------------------------------------------------------------
// El movimiento solo existe MIENTRAS DURA
// ---------------------------------------------------------------------------
/*
  LO REPORTADO (04/10/2026). «La velocidad de la navegación ha empeorado
  considerablemente… está demasiado lenta, con movimientos acartonados. Se
  nota especialmente en Inicio y Explorar, pero toda la aplicación está así».

  LA CAUSA. Este sistema de movimiento convirtió cada cosa pulsable —y cada
  icono y cada contador de cada publicación— en un componente animado SIEMPRE
  MONTADO. En Inicio eran más de cien, donde antes había uno. La biblioteca de
  animación guarda una entrada por cada uno y las vuelve a aplicar todas cada
  vez que React confirma un cambio; en Android, desplazar una lista confirma
  uno por fotograma. Montar cada uno, además, para el hilo de JavaScript.

  LA REGLA NUEVA. En reposo no hay nada animado: una vista normal. Lo animado
  se monta cuando algo cambia, dura lo que dura el gesto y se desmonta. Lo que
  deciden estas funciones es CUÁNDO hay algo que animar.
*/

/**
 * El estilo de algo pulsable según esté o no bajo el dedo.
 *
 * Sin animación: encoge y atenúa en el acto, y vuelve en el acto. Es lo que
 * hace que mil botones no cuesten nada mientras nadie los toca.
 *
 * `null` cuando no hay nada que pintar: en reposo y sin atenuar, que es el
 * caso de casi todos casi siempre, ni siquiera se crea un objeto de estilo.
 */
export function estiloPulsado(
  pulsado: boolean,
  opciones: { escala: number; atenuar: number; opacidad: number; reducir: boolean },
): { opacity: number; transform?: { scale: number }[] } | null {
  const opacity = opciones.opacidad * (pulsado ? opciones.atenuar : 1);
  const encoge = pulsado && !opciones.reducir && opciones.escala !== 1;
  if (!encoge && opacity === 1) return null;
  return encoge ? { opacity, transform: [{ scale: opciones.escala }] } : { opacity };
}

/**
 * Si un icono tiene que dar el salto: cambió de estado SIENDO EL MISMO
 * elemento. Una celda reciclada que pasa a pintar otra publicación —ya
 * guardada— no acaba de guardarse: no salta.
 */
export function daElSalto(
  antes: { activo: boolean; clave?: string },
  ahora: { activo: boolean; clave?: string },
): boolean {
  return antes.clave === ahora.clave && antes.activo !== ahora.activo;
}

/**
 * Hacia dónde entra una cifra que cambia: 1 si sube, -1 si baja, 0 si no hay
 * nada que mover (no cambió, o es la cifra de otro elemento).
 */
export function sentidoDelCambio(
  antes: { valor: number; clave?: string },
  ahora: { valor: number; clave?: string },
): 1 | -1 | 0 {
  if (antes.clave !== ahora.clave || antes.valor === ahora.valor) return 0;
  return ahora.valor > antes.valor ? 1 : -1;
}

/**
 * Qué hace el globo de no leídos al cambiar la cuenta: aparece, crece o nada.
 * Que baje no se celebra, y al montarse con su cuenta tampoco se mueve.
 */
export function saltoDelGlobo(antes: number, ahora: number): 'aparece' | 'crece' | null {
  if (ahora <= 0) return null;
  if (antes <= 0) return 'aparece';
  return ahora > antes ? 'crece' : null;
}

export type ModoDeEntrada = { clave?: string; animada: boolean };

/**
 * Si algo que «entra» (`Aparecer`) se monta animado o como una vista normal.
 *
 *   - Lo que ya está en su sitio —el historial de un chat— es una vista
 *     normal. Son casi todas las filas, y no llegan a montar nada animado.
 *   - Lo que entra de verdad se monta animado.
 *   - UNA VEZ ANIMADA, LA FILA SIGUE SIÉNDOLO, pinte lo que pinte después.
 *     Cambiar de componente remonta lo que lleva dentro, y el mensaje que se
 *     acaba de enviar no puede parpadear cuando el servidor lo confirma —que
 *     es justo cuando deja de ser «nuevo» y, además, cambia de identificador—.
 *     Son las pocas filas por las que pasó un mensaje recién enviado.
 */
export function modoDeEntrada(
  previo: ModoDeEntrada | null,
  clave: string | undefined,
  quieta: boolean,
): ModoDeEntrada {
  const animada = (previo?.animada ?? false) || !quieta;
  if (previo && previo.clave === clave && previo.animada === animada) return previo;
  return { clave, animada };
}
