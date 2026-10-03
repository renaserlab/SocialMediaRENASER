/**
 * El cerrojo común contra el doble envío.
 *
 * Un botón cuya acción tarda —guardar, enviar, publicar— no puede admitir un
 * segundo toque mientras la primera sigue en curso: la acción se haría dos
 * veces. Cada pantalla lo resolvía por su cuenta (o no lo resolvía), y por eso
 * vive aquí, en un sitio, y `Button` lo usa siempre.
 *
 * SOLO SE CIERRA SI LA ACCIÓN DEVUELVE UNA PROMESA. Una acción que termina en
 * el acto (navegar, abrir una hoja, `() => void guardar()`) no tiene nada que
 * esperar y el botón sigue como siempre.
 *
 * ES UNA FUNCIÓN PURA, FUERA DEL COMPONENTE, PARA PODER PROBARLA: el botón no
 * se puede montar en las pruebas de este proyecto, y esto es lo único suyo que
 * puede hacer daño.
 */

/** Una referencia de React (`useRef(false)`) o cualquier cosa con esa forma. */
export type Cerrojo = { current: boolean };

/**
 * Ejecuta `accion` salvo que el cerrojo esté echado. Si devuelve una promesa,
 * echa el cerrojo, avisa con `alCambiar(true)` y lo suelta —avisando con
 * `alCambiar(false)`— cuando termina, bien o mal.
 *
 * EL FALLO NO SE TRAGA. Devuelve una promesa que falla con el mismo error: es
 * de quien escribió la acción, igual que antes de existir el cerrojo. Si la
 * acción no devuelve una promesa, devuelve `undefined`.
 */
export function tocarConCerrojo(
  cerrojo: Cerrojo,
  accion: () => unknown,
  alCambiar: (ocupado: boolean) => void,
): Promise<void> | undefined {
  // El cerrojo se mira y se echa en el mismo toque, sin esperar a que nadie
  // vuelva a pintar: dos toques seguidos llegan antes que el siguiente render.
  if (cerrojo.current) return undefined;
  const resultado = accion();
  if (!resultado || typeof (resultado as { then?: unknown }).then !== 'function') return undefined;
  cerrojo.current = true;
  alCambiar(true);
  const soltar = () => {
    cerrojo.current = false;
    alCambiar(false);
  };
  // `Promise.resolve`: lo que llega puede ser cualquier cosa con `then`, y de
  // aquí tiene que salir una promesa de verdad.
  return Promise.resolve(resultado as PromiseLike<unknown>).then(soltar, (error: unknown) => {
    soltar();
    throw error;
  });
}
