import React, { createContext, useContext, useMemo, useRef } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler';
import { usePathname, useRouter } from 'expo-router';

/**
 * Cambiar de seccion arrastrando el dedo, como en Facebook o Instagram.
 *
 * DECISION DE ARQUITECTURA: esto NO es un segundo navegador.
 *
 * La tentacion evidente era montar un carrusel (un pager) con las cinco
 * pantallas dentro y sincronizarlo con la barra. Eso habria creado una segunda
 * verdad sobre "en que seccion estoy" —la del pager y la de expo-router— que
 * hay que mantener sincronizadas a mano y que se desincronizan a la primera
 * navegacion que no venga del gesto (un enlace, una notificacion, el boton
 * atras). Aqui el gesto NO navega por su cuenta: solo traduce un arrastre en la
 * MISMA llamada que ya hace la barra inferior al pulsarla. La ruta la sigue
 * decidiendo expo-router, y la pestaña activa se sigue leyendo de ahi, asi que
 * gesto y barra no pueden discrepar.
 *
 * A cambio, el contenido no se arrastra con el dedo: la seccion cambia al
 * soltar. Es el precio de no duplicar la navegacion, y se paga a gusto.
 */

/** Las cinco secciones, en el orden en que aparecen en la barra inferior. */
const SECCIONES = [
  { ruta: '/home', destino: '/(tabs)/home' },
  { ruta: '/explore', destino: '/(tabs)/explore' },
  { ruta: '/create', destino: '/(tabs)/create' },
  { ruta: '/messages', destino: '/(tabs)/messages' },
  { ruta: '/profile', destino: '/(tabs)/profile' },
] as const;

/**
 * Cuanto hay que arrastrar en horizontal para que el gesto se de por bueno.
 *
 * Por debajo de esto el dedo todavia puede estar decidiendo si va a subir o a
 * bajar, y una lista que se desplaza a la vez que cambia de seccion se siente
 * como un fallo.
 */
const DISTANCIA_MINIMA = 60;
/** Un golpe corto pero rapido tambien cuenta: es como se pasa de pagina. */
const VELOCIDAD_MINIMA = 500;

/**
 * Margen antes de decidir que el gesto es horizontal.
 *
 * El muro se lee en vertical, asi que la duda se resuelve SIEMPRE a favor del
 * desplazamiento: hacen falta 24 px claros en horizontal, y basta con 18 px en
 * vertical para descartar el cambio de seccion.
 */
const MARGEN_HORIZONTAL = 24;
const MARGEN_VERTICAL = 18;

/**
 * El gesto de cambiar de seccion, para que lo que hay dentro pueda bloquearlo.
 * Vale `null` donde el gesto no existe (web), y entonces `SinCambioDeSeccion`
 * no hace nada.
 */
const GestoDeSeccion = createContext<GestureType | null>(null);

/**
 * Zona en la que arrastrar NO cambia de seccion.
 *
 * Envuelve lo que ya usa el arrastre horizontal para otra cosa: un carrusel de
 * historias, una fila de filtros, la barra de avance de un video. Sin esto,
 * mover un carrusel se llevaba por delante la pantalla entera.
 *
 * `activarAlTocar` es para lo que NO es un ScrollView (una barra con
 * PanResponder, por ejemplo): reserva el gesto desde el primer contacto, sin
 * esperar a que el hijo empiece a moverse.
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
  return <GestureDetector gesture={bloqueo}>{children}</GestureDetector>;
}

/**
 * Envuelve el navegador de pestañas y traduce los arrastres horizontales en
 * cambios de seccion.
 *
 * Solo en movil: en el navegador se cambia de pagina con el raton y el teclado,
 * y un arrastre horizontal ahi es seleccionar texto, no pasar de pantalla.
 */
export function CambioDeSeccionPorGesto({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  /*
    El gesto se crea UNA vez (si se recreara en cada navegacion, el arrastre en
    curso se cancelaria al cambiar de pestaña), asi que no puede leer `pathname`
    directamente: se quedaria con el de la primera pantalla. Por eso la ruta
    viva va por referencia.
  */
  const vivo = useRef({ pathname, router });
  vivo.current.pathname = pathname;
  vivo.current.router = router;

  const gesto = useMemo(() => {
    if (Platform.OS === 'web') return null;

    return (
      Gesture.Pan()
        .activeOffsetX([-MARGEN_HORIZONTAL, MARGEN_HORIZONTAL])
        .failOffsetY([-MARGEN_VERTICAL, MARGEN_VERTICAL])
        /*
          El manejador toca el router, que es estado de React: tiene que correr
          en el hilo de JavaScript, no en el de la interfaz.
        */
        .runOnJS(true)
        .onEnd((evento) => {
          const decidido =
            Math.abs(evento.translationX) > DISTANCIA_MINIMA ||
            Math.abs(evento.velocityX) > VELOCIDAD_MINIMA;
          if (!decidido) return;

          /*
            Solo se salta entre las cinco secciones. Dentro de las pestañas
            tambien viven destinos que no son seccion (el perfil de otra
            persona, un circulo, un audio): ahi el arrastre no significa nada y
            cambiar de pantalla seria perder lo que se estaba viendo.
          */
          const actual = SECCIONES.findIndex((s) => vivo.current.pathname === s.ruta);
          if (actual < 0) return;

          // Dedo hacia la izquierda = avanzar, igual que al pasar una pagina.
          const destino = actual + (evento.translationX < 0 ? 1 : -1);
          if (destino < 0 || destino >= SECCIONES.length) return;

          // `navigate`, no `push`: es exactamente lo que hace pulsar la barra
          // inferior, asi que la pestaña activa y el historial salen iguales.
          vivo.current.router.navigate(SECCIONES[destino]!.destino as never);
        })
    );
  }, []);

  if (!gesto) return <>{children}</>;

  return (
    <GestoDeSeccion.Provider value={gesto}>
      <GestureDetector gesture={gesto}>
        <View style={styles.lleno} collapsable={false}>
          {children}
        </View>
      </GestureDetector>
    </GestoDeSeccion.Provider>
  );
}

const styles = StyleSheet.create({ lleno: { flex: 1 } });
