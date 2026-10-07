/**
 * CÓMO SE SALE DE UN TRÁMITE QUE HA TERMINADO BIEN.
 *
 * Un trámite son varias pantallas seguidas para conseguir una cosa: pedir el
 * correo, abrir el enlace y escribir la contraseña nueva; o crear un curso,
 * rellenar sus pasos y publicarlo. Al terminar, esas pantallas ya no sirven
 * para nada, y dos cosas tienen que ser ciertas:
 *
 *   · se llega a un sitio que ENSEÑA el resultado, y
 *   · «Atrás» no devuelve a un formulario que ya se envió.
 *
 * Antes cada pantalla lo resolvía sustituyéndose a sí misma por otra
 * (`router.replace`), y debajo se quedaba lo que hubiera: tras cambiar la
 * contraseña, las pantallas de acceso; tras publicar un curso, la ficha del
 * curso encima de la lista SIN refrescar. Aquí hay dos salidas con nombre, y
 * cada trámite elige la suya.
 *
 * Solo dependen de lo que usan de `router`, para poder probarlas sin la
 * librería delante.
 */

type Destino = string;

type PilaQueSeVacia = {
  canDismiss: () => boolean;
  dismissAll: () => void;
  replace: (destino: never) => void;
};

type PilaQueRetrocede = {
  dismissTo: (destino: never) => void;
};

/**
 * Llega a `destino` y deja la pila con UNA sola pantalla.
 *
 * Para cuando lo anterior deja de tener sentido entero: después de fijar la
 * contraseña no se puede volver ni al enlace, ni al formulario del correo, ni
 * a la pantalla de entrar. Las dos órdenes se resuelven en el mismo paso, así
 * que la pila no llega a pintarse a medias.
 */
export function empezarDeNuevoEn(router: PilaQueSeVacia, destino: Destino): void {
  if (router.canDismiss()) router.dismissAll();
  router.replace(destino as never);
}

/**
 * Vuelve a `destino` si ya está en la pila y, si no, lo pone en el lugar de la
 * pantalla actual.
 *
 * Para cuando el resultado se ve en una lista de la que se salió: publicar un
 * curso devuelve a Cursos. Volver a la pantalla que ya existe —en vez de abrir
 * otra copia encima— es lo que hace que «Atrás» lleve desde ahí a donde se
 * estaba antes, y no otra vez al asistente.
 *
 * La pantalla a la que se vuelve tiene que refrescarse al recuperar el foco:
 * si no, enseña lo que había antes del trámite.
 */
export function volverA(router: PilaQueRetrocede, destino: Destino): void {
  router.dismissTo(destino as never);
}
