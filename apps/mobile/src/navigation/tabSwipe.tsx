import React, { createContext, useContext, useMemo } from 'react';
import { Platform } from 'react-native';
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler';

/**
 * Zonas que NO cambian de seccion al arrastrar.
 *
 * El carrusel de secciones (ver `SwipeTabs.tsx`) escucha el arrastre horizontal
 * desde un ancestro comun a todas las pantallas. Eso tiene un efecto secundario
 * inevitable: cuando ese gesto se activa, cancela el gesto nativo de lo que
 * hubiera debajo. Sin blindar, mover el carrusel de historias o arrastrar la
 * barra de avance de un video se llevaba por delante la pantalla entera.
 *
 * Aqui vive el contrato entre los dos: el carrusel PUBLICA su gesto, y lo que
 * ya usa el arrastre horizontal para otra cosa se declara con
 * `SinCambioDeSeccion` para que el suyo tenga prioridad.
 */

/**
 * Los arrastres horizontales que hay POR ENCIMA de un punto del arbol.
 *
 * Empezo siendo uno solo —el carrusel de secciones— y resulto no bastar. La
 * pantalla de Crear tiene ADEMAS su propio arrastre para cambiar de tipo de
 * publicacion, asi que dentro de ella una fila que se desliza compite con dos
 * gestos, no con uno: blindarse solo contra el carrusel dejaba que arrastrar
 * los temas de una publicacion cambiara de modo.
 *
 * Por eso es una lista y los proveedores se ANIDAN. Cada pantalla que declare
 * un arrastre propio lo anade, y `SinCambioDeSeccion` los bloquea todos: quien
 * se blinda no tiene por que saber cuantos hay ni de quien son.
 *
 * Vacia fuera de las pestanas —el mismo reproductor de video se usa en
 * pantallas que no son seccion—, y entonces `SinCambioDeSeccion` no hace nada.
 */
const GestosDeArriba = createContext<readonly GestureType[]>([]);

/**
 * Publica un arrastre horizontal para que lo de dentro pueda blindarse de el.
 *
 * Lo usan el carrusel de secciones y cualquier pantalla con arrastre propio.
 * Se anida: el de dentro no sustituye al de fuera, se suma.
 */
export function ProveedorDeGestoDeSeccion({
  gesto,
  children,
}: {
  gesto: GestureType;
  children: React.ReactNode;
}) {
  const heredados = useContext(GestosDeArriba);
  const todos = useMemo(() => [...heredados, gesto], [heredados, gesto]);
  return <GestosDeArriba.Provider value={todos}>{children}</GestosDeArriba.Provider>;
}

/**
 * El gesto de seccion, para componer con el uno propio.
 *
 * `SinCambioDeSeccion` cubre el caso normal —una fila que se arrastra y ya—,
 * pero una pantalla puede necesitar SU PROPIO arrastre horizontal con reglas
 * suyas: la de Crear cambia de tipo de publicacion deslizando. Esa pantalla
 * declara su gesto y le anade `.blocksExternalGesture(gestoDeSeccion)`, que es
 * lo que hace que el suyo tenga prioridad sobre el carrusel.
 *
 * Devuelve `null` fuera de las pestanas, y entonces no hay nada que bloquear.
 */
export function useGestoDeSeccion(): GestureType | null {
  // El de mas afuera, que es el del carrusel de secciones. Una pantalla que
  // declara su propio arrastre lo hace ANTES de publicarlo, asi que aqui
  // todavia no se ve el suyo: recibe el que tiene que bloquear.
  return useContext(GestosDeArriba)[0] ?? null;
}

/**
 * Zona en la que arrastrar NO cambia de seccion.
 *
 * Envuelve lo que ya usa el arrastre horizontal para otra cosa: un carrusel de
 * historias, una fila de filtros, la barra de avance de un video.
 *
 * `activarAlTocar` es para lo que NO es un ScrollView (una barra con
 * PanResponder, por ejemplo): reserva el gesto desde el primer contacto, sin
 * esperar a que el hijo empiece a moverse, porque ahi no hay ningun
 * desplazamiento nativo al que asomarse.
 */
export function SinCambioDeSeccion({
  children,
  activarAlTocar = false,
}: {
  children: React.ReactElement;
  activarAlTocar?: boolean;
}) {
  const gestosDeArriba = useContext(GestosDeArriba);

  const bloqueo = useMemo(() => {
    if (gestosDeArriba.length === 0) return null;
    // TODOS los de arriba, no solo el primero: dentro de Crear hay dos.
    const nativo = Gesture.Native().blocksExternalGesture(...gestosDeArriba);
    return activarAlTocar ? nativo.shouldActivateOnStart(true).disallowInterruption(true) : nativo;
  }, [gestosDeArriba, activarAlTocar]);

  if (!bloqueo) return children;

  /*
    En el navegador ademas hay que marcarlo para el CSS del carrusel (ver
    CSS_WEB en SwipeTabs.tsx): sin la marca, la regla que suelta el arrastre
    horizontal en toda la seccion tambien se lo quitaria a esta fila, y dejaria
    de poder moverse. En movil la marca no existe y no estorba.
  */
  const hijo =
    Platform.OS === 'web'
      ? React.cloneElement(children, {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          dataSet: { ...((children.props as any)?.dataSet ?? {}), swipelibre: '1' },
        } as never)
      : children;

  return <GestureDetector gesture={bloqueo}>{hijo}</GestureDetector>;
}
