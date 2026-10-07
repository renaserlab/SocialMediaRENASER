/**
 * Cuándo una conversación baja sola hasta lo último, y cuándo no.
 *
 * LO REPORTADO (06/10/2026, en teléfono). Tres veces lo mismo:
 *
 *   - al abrir un chat, a veces había que deslizar hasta abajo para ver lo
 *     último;
 *   - con el teclado abierto, el mensaje recién enviado quedaba por debajo del
 *     redactor y había que deslizar para comprobar que había salido;
 *   - y lo mismo con un mensaje que llegaba.
 *
 * LA CAUSA. La lista sabía seguir el final solo si YA estaba casi abajo, y lo
 * medía contra el alto que tiene a la vista. Al abrirse el teclado ese alto se
 * queda en la mitad y lo último pasa a estar «lejos»: desde ese momento dejaba
 * de seguir nada.
 *
 * LA REGLA, la de cualquier chat:
 *
 *   - lo que uno manda se ve SIEMPRE: se baja;
 *   - lo que llega se ve si se estaba abajo, o cerca: se baja;
 *   - quien ha subido a leer el historial no pierde el sitio: se le avisa de
 *     que hay algo nuevo abajo, con un botón para ir.
 *
 * Y «estar abajo» se recuerda de un cambio de tamaño al siguiente: que el
 * teclado encoja la lista no es haber subido a leer.
 *
 * Son funciones sin React, para poder probarlas. Las usa `ChatScreen`.
 */

export type MedidasDeLaLista = {
  /** Lo que se ha desplazado desde arriba. */
  desplazado: number;
  /** El alto que se ve. */
  alto: number;
  /** El alto de todo el contenido. */
  contenido: number;
};

/** Con menos margen que esto, una burbuja alta ya contaría como «haber subido». */
export const MARGEN_PEGADO_MINIMO = 120;
/** La parte del alto a la vista que todavía cuenta como «estar abajo». */
const PARTE_DEL_ALTO = 0.35;

/** Lo que falta por ver hasta el final. Nunca negativo (el rebote de iOS). */
export function distanciaAlFinal(medidas: MedidasDeLaLista): number {
  return Math.max(0, medidas.contenido - (medidas.desplazado + medidas.alto));
}

/** Si lo último está a la vista, o casi. */
export function estaPegadoAlFinal(medidas: MedidasDeLaLista): boolean {
  if (medidas.alto <= 0) return true;
  return distanciaAlFinal(medidas) <= Math.max(MARGEN_PEGADO_MINIMO, medidas.alto * PARTE_DEL_ALTO);
}

export type QueHacer = 'nada' | 'bajar' | 'bajar-sin-animar' | 'avisar';

/**
 * Qué hacer cuando cambia el último elemento de la conversación.
 *
 * `antes` y `ahora` son su identificador. Paginar hacia atrás no lo cambia —
 * lo que entra, entra por arriba—, así que cargar historial no mueve nada.
 */
export function queHacerConLoUltimo(caso: {
  antes: string | null;
  ahora: string | null;
  /** Lo último es de quien mira. */
  mio: boolean;
  /** Se estaba viendo el final. */
  pegado: boolean;
}): QueHacer {
  if (caso.ahora === null || caso.ahora === caso.antes) return 'nada';
  // La conversación acaba de pintarse: se abre por el final, sin recorrido.
  if (caso.antes === null) return 'bajar-sin-animar';
  if (caso.mio || caso.pegado) return 'bajar';
  return 'avisar';
}
