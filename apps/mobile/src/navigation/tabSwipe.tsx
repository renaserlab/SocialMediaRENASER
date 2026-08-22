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
 * El gesto de cambiar de seccion, para que lo que hay dentro pueda bloquearlo.
 * Vale `null` fuera de las pestanas —el mismo reproductor de video se usa en
 * pantallas que no son seccion—, y entonces `SinCambioDeSeccion` no hace nada.
 */
const GestoDeSeccion = createContext<GestureType | null>(null);

export function ProveedorDeGestoDeSeccion({
  gesto,
  children,
}: {
  gesto: GestureType;
  children: React.ReactNode;
}) {
  return <GestoDeSeccion.Provider value={gesto}>{children}</GestoDeSeccion.Provider>;
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
  return useContext(GestoDeSeccion);
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
  const gestoDeSeccion = useContext(GestoDeSeccion);

  const bloqueo = useMemo(() => {
    if (!gestoDeSeccion) return null;
    const nativo = Gesture.Native().blocksExternalGesture(gestoDeSeccion);
    return activarAlTocar ? nativo.shouldActivateOnStart(true).disallowInterruption(true) : nativo;
  }, [gestoDeSeccion, activarAlTocar]);

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
