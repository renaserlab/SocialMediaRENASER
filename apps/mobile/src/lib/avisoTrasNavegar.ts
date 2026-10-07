/**
 * UN AVISO NO SE ENSEÑA MIENTRAS LA PANTALLA ESTÁ CAMBIANDO.
 *
 * EL FALLO (visto en teléfono el 06 y el 07/10/2026). Al guardar la contraseña
 * nueva y al publicar un curso, la aplicación se quedaba en una pantalla gris.
 * El dato se guardaba —al volver a abrir, la sesión estaba iniciada y el curso
 * publicado—; lo que no llegaba a verse era la pantalla siguiente.
 *
 * LO QUE TENÍAN EN COMÚN esos dos sitios, y solo ellos entre los que se habían
 * probado en teléfono: pedían el aviso de «hecho» y, EN LA LÍNEA SIGUIENTE,
 * sustituían la pantalla (`router.replace`). El aviso se monta con su animación
 * de entrada justo en el fotograma en que la pila quita una pantalla y pone
 * otra. Las sustituciones SIN aviso al lado —entrar con la cuenta, abrir la
 * sala de un directo recién creado, llegar a la pantalla de contraseña desde el
 * enlace del correo— funcionan en esos mismos teléfonos.
 *
 * LO QUE NO SE SABE. No se ha podido reproducir fuera del teléfono: en la copia
 * web la pantalla siguiente se pinta siempre, así que el fallo está en cómo
 * Android monta las vistas, no en el orden de navegación. Por eso la regla se
 * escribe como lo que es —una regla de uso, que además es mejor por sí misma— y
 * no como el arreglo de una causa demostrada.
 *
 * LA REGLA. El aviso pertenece a la pantalla a la que se LLEGA, no a la que se
 * deja: enseñarlo sobre una pantalla que desaparece en dos décimas es gastarlo.
 * Así que espera a que la pantalla esté quieta.
 *
 *   · Sin cambio de pantalla cerca, sale casi al instante (`ESPERA_MINIMA_MS`).
 *     Ese instante no es un adorno: es lo que deja ver si DETRÁS del aviso viene
 *     una navegación, que es exactamente el caso del fallo.
 *   · Con un cambio de pantalla reciente, sale cuando la transición ha
 *     terminado y un poco más.
 *
 * Función pura y sin importaciones a propósito: el anfitrión le dice cuánto
 * dura una transición (`navigation/transicion`) y ella solo contesta cuánto
 * falta.
 */

/** Dos fotogramas. Lo justo para enterarse de que detrás viene una navegación. */
export const ESPERA_MINIMA_MS = 32;

/** Aire después de la transición: que la pantalla nueva ya esté pintada. */
export const MARGEN_TRAS_LA_TRANSICION_MS = 130;

/**
 * Milisegundos que faltan para poder enseñar un aviso.
 *
 * @param ahora                  El instante actual.
 * @param ultimoCambioDePantalla Cuándo cambió la pantalla por última vez, o
 *                               `null` si no ha cambiado desde que arrancó.
 * @param duracionDeLaTransicion Lo que tarda la pila en pasar de una a otra.
 */
export function esperaParaPresentar(
  ahora: number,
  ultimoCambioDePantalla: number | null,
  duracionDeLaTransicion: number,
): number {
  if (ultimoCambioDePantalla === null) return ESPERA_MINIMA_MS;
  const quieta = duracionDeLaTransicion + MARGEN_TRAS_LA_TRANSICION_MS;
  const falta = ultimoCambioDePantalla + quieta - ahora;
  // Un reloj que retrocede (cambio de hora del teléfono) no puede dejar el
  // aviso esperando minutos: nunca más de lo que tarda una pantalla en estar
  // quieta.
  return Math.max(ESPERA_MINIMA_MS, Math.min(falta, quieta));
}
