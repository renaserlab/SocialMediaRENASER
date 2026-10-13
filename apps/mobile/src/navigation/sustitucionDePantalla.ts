/**
 * UNA PANTALLA QUE SUSTITUYE A OTRA LLEGA SIN ANIMACIÓN (Android).
 *
 * EL FALLO (teléfono; 06 y 07/10/2026, y otra vez el 12/10 al publicar un
 * curso). Al terminar un trámite —publicar un curso, crear un producto, fijar
 * la contraseña nueva— la aplicación se quedaba en una pantalla gris. El dato
 * se guardaba; lo que no se veía era la pantalla siguiente, y había que cerrar
 * la aplicación.
 *
 * QUÉ ES ESE GRIS. Ninguna pantalla de Z es gris: es el fondo que
 * `react-native-screens` le pone al contenedor de cada pantalla cuando nadie
 * le da otro (el del tema por defecto de la navegación). O sea, se está viendo
 * un contenedor SIN contenido.
 *
 * DE DÓNDE SALE. Todos los sitios donde pasó hacen lo mismo: quitan la
 * pantalla de arriba y ponen otra nueva EN EL MISMO PASO (`replace`, o
 * `dismissTo` hacia una pantalla que no estaba en la pila, que es una
 * sustitución con otro nombre). En Android eso es una sola transacción con dos
 * animaciones a la vez: la pantalla que entra y la que sale. La que sale ya
 * está desmontada por React, y la librería la mantiene dibujada mientras dura
 * su animación (`Screen.startRemovalTransition` → `startViewTransition` sobre
 * todo su árbol) hasta que la animación avisa de que terminó
 * (`endRemovalTransition`). Si ese aviso no llega, el contenedor de la pantalla
 * retirada se queda pintado ENCIMA de la nueva, ya vacío: su fondo gris.
 * Avanzar o volver atrás no pasan por ahí —al avanzar la pantalla de abajo no
 * se desmonta, al volver no entra ninguna nueva—, y por eso el resto de la
 * navegación funciona.
 *
 * LO QUE NO SE SABE. Qué hace que ese aviso se pierda: no se ha podido
 * reproducir fuera del teléfono (en la copia web no hay animación nativa), y
 * en el repositorio de la librería está abierto, sin causa encontrada, con el
 * mismo síntoma —«una página en blanco con solo el fondo», solo en teléfonos
 * reales— y con la misma salida que se aplica aquí: quitar la animación
 * (software-mansion/react-native-screens, discusión 2746).
 *
 * LA REGLA. La pantalla que llega SUSTITUYENDO a la de arriba entra sin
 * animación. Sin animación no hay dos pantallas moviéndose a la vez ni
 * reordenación del dibujo (`needsDrawReordering` es falso con `none`), que es
 * justo el tramo donde se queda colgada. Avanzar y volver atrás siguen
 * deslizando como siempre. Va en un solo sitio —la pila raíz— y no en cada
 * `router.replace`: así cubre también los que nadie ha denunciado todavía.
 *
 * Cuando la llegada termina, la pantalla recupera su animación normal: si no,
 * «Atrás» desde ella también saldría de golpe.
 *
 * Sin importaciones a propósito: se prueba sin la librería delante.
 */

/** Lo que hace falta saber de la pila en un instante: qué hay y qué está arriba. */
export type FotoDeLaPila = {
  claves: readonly string[];
  cima: string | null;
};

type EstadoDeLaPila = {
  index: number;
  routes: readonly { key: string }[];
};

export const PILA_VACIA: FotoDeLaPila = { claves: [], cima: null };

export function fotoDe(estado: EstadoDeLaPila | null | undefined): FotoDeLaPila {
  if (!estado || estado.routes.length === 0) return PILA_VACIA;
  const claves = estado.routes.map((ruta) => ruta.key);
  return { claves, cima: estado.routes[estado.index]?.key ?? null };
}

/**
 * ¿La pila pasó de `antes` a `ahora` SUSTITUYENDO la pantalla de arriba?
 *
 * Tres cosas a la vez: la de arriba es otra, esa otra no estaba, y la que
 * estaba arriba ya no está. Avanzar falla la tercera (la anterior sigue
 * debajo); volver atrás falla la segunda (la que queda ya existía). La
 * primera pantalla de la aplicación no sustituye a nadie.
 */
export function esSustitucion(antes: FotoDeLaPila, ahora: FotoDeLaPila): boolean {
  if (antes.cima === null || ahora.cima === null) return false;
  if (antes.cima === ahora.cima) return false;
  if (antes.claves.includes(ahora.cima)) return false;
  return !ahora.claves.includes(antes.cima);
}

/**
 * Lo que la pila raíz recuerda entre un dibujo y el siguiente.
 *
 * Es un objeto que se modifica, y no un valor nuevo cada vez, porque quien lo
 * consulta son las opciones de la pila, que se calculan MIENTRAS se dibuja:
 * ahí no se puede guardar estado de React.
 */
export type RegistroDeLlegadas = {
  foto: FotoDeLaPila;
  /** Pantallas que llegaron sustituyendo y todavía no terminaron de llegar. */
  sinAnimacion: Set<string>;
};

export function nuevoRegistro(): RegistroDeLlegadas {
  return { foto: PILA_VACIA, sinAnimacion: new Set() };
}

/**
 * Apunta cómo está la pila ahora. Si acaba de haber una sustitución, la
 * pantalla nueva queda marcada.
 *
 * Se puede llamar las veces que haga falta con el mismo estado —las opciones
 * se calculan una vez por pantalla y por dibujo—: solo la primera cambia algo.
 */
export function anotar(registro: RegistroDeLlegadas, ahora: FotoDeLaPila): void {
  if (ahora.cima === registro.foto.cima && ahora.claves.length === registro.foto.claves.length) return;
  if (esSustitucion(registro.foto, ahora) && ahora.cima !== null) {
    registro.sinAnimacion.add(ahora.cima);
  }
  // Lo que ya no está en la pila no puede volver a preguntar.
  for (const clave of registro.sinAnimacion) {
    if (!ahora.claves.includes(clave)) registro.sinAnimacion.delete(clave);
  }
  registro.foto = ahora;
}

export function llegaSinAnimacion(registro: RegistroDeLlegadas, clave: string): boolean {
  return registro.sinAnimacion.has(clave);
}

/**
 * La pantalla terminó de llegar: recupera su animación normal.
 *
 * Devuelve si había algo que cambiar, para que quien llama solo vuelva a
 * dibujar la pila cuando hace falta.
 */
export function asentar(registro: RegistroDeLlegadas, clave: string | undefined): boolean {
  if (clave === undefined) return false;
  return registro.sinAnimacion.delete(clave);
}
