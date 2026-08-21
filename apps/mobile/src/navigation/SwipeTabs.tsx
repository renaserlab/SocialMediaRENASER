import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { Freeze } from 'react-freeze';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {
  createNavigatorFactory,
  useNavigationBuilder,
  type ParamListBase,
  type TabNavigationState,
} from '@react-navigation/native';
import { TabRouter, type TabActionHelpers, type TabRouterOptions } from '@react-navigation/routers';

import { ProveedorDeGestoDeSeccion } from '@/navigation/tabSwipe';
import { ORDEN_SECCIONES, posicionDeSeccion } from '@/navigation/secciones';

/**
 * Navegador de pestanas con carrusel: la pantalla sigue al dedo.
 *
 * POR QUE UN NAVEGADOR PROPIO. Lo que habia era un gesto que, al SOLTAR,
 * llamaba al router. Funcionaba, pero no ensena nada mientras el dedo se mueve,
 * y eso es justo lo que se pedia: ver aparecer la seccion vecina antes de
 * decidir. Para eso las secciones tienen que estar colocadas fisicamente una al
 * lado de otra, y el navegador de pestanas de React Navigation no ofrece
 * transicion interactiva de ningun tipo: pinta una sola pantalla a la vez.
 *
 * La alternativa era `material-top-tabs`, que si trae carrusel. Se descarto por
 * dos motivos concretos, no por gusto: arrastra `react-native-pager-view`, que
 * es un modulo NATIVO (obliga a una compilacion nueva, con lo que la mejora no
 * llegaria a la aplicacion ya instalada ni esta claro que funcione en la web),
 * y meteria en el carrusel las cinco rutas de DETALLE que viven dentro de las
 * pestanas —perfil ajeno, circulo, audio, seguidores, seguidos—, de modo que
 * deslizar desde Perfil acabaria en el perfil de un desconocido sin parametros.
 * Habria hecho falta sacarlas del grupo y volver a resolver la barra flotante
 * en ellas.
 *
 * Este navegador usa el MISMO `TabRouter` que el de antes, asi que el historial
 * entre pestanas, el `backBehavior="history"` y el boton Atras siguen
 * comportandose exactamente igual: no hay una segunda pila en paralelo. Lo
 * unico que cambia es quien PINTA las pantallas.
 */

/** Cuanto hay que arrastrar, en proporcion al ancho, para que se de por bueno. */
const UMBRAL_DISTANCIA = 0.3;
/** Un golpe corto pero rapido tambien cuenta: asi se pasa de pagina. */
const UMBRAL_VELOCIDAD = 500;
/** Margen antes de decidir que el gesto es horizontal y no una lectura vertical. */
const MARGEN_HORIZONTAL = 20;
const MARGEN_VERTICAL = 18;
/**
 * Cuanto se deja mover el dedo cuando no hay nada al otro lado.
 *
 * Un cuarto del recorrido: se nota que la pantalla responde —el gesto no
 * parece roto— pero se entiende enseguida que ahi se acaba el camino. Es la
 * misma resistencia elastica que hace cualquier lista al llegar al final.
 */
const RESISTENCIA_EN_EL_BORDE = 0.25;

/**
 * Duracion del ajuste al soltar.
 *
 * Corto a proposito. Lo que se percibe como lento no es el gesto sino lo que
 * pasa DESPUES de soltar, asi que 200 ms con salida suave: suficiente para que
 * no sea un corte seco, poco para que nadie lo espere.
 */
const AJUSTE = { duration: 200, easing: Easing.out(Easing.cubic) };
/** Volver atras cuando no se supero el umbral: aun mas corto, no se ha ido a ningun sitio. */
const REGRESO = { duration: 160, easing: Easing.out(Easing.cubic) };

/**
 * Cuando se preparan las secciones vecinas.
 *
 * No en el primer render: al arrancar compiten con el muro por la misma
 * conexion y por un servidor recien despierto, y el muro es lo que la persona
 * vino a ver (mismo criterio que ya usa HomeScreen con sus datos secundarios).
 * Setecientos milisegundos despues ya no molestan a nadie y llegan de sobra
 * antes del primer arrastre.
 */
const ESPERA_PARA_PREPARAR_VECINAS = 700;

export type OpcionesDeSeccion = {
  title?: string;
};

type EventosDeSeccion = {
  tabPress: { data: undefined; canPreventDefault: true };
};

/*
  Los tipos se DERIVAN de lo que devuelve `useNavigationBuilder` en vez de
  escribirlos a mano. Escribirlos a mano parecia mas legible, pero significaba
  mantener a mano una copia de la forma interna de React Navigation, que ya
  falla al primer detalle (un `Descriptor` no lleva `NavigationHelpers` sino un
  `NavigationProp`). Derivandolos, si la libreria cambia, el compilador avisa
  aqui y no en tiempo de ejecucion.
*/
type Constructor = ReturnType<
  typeof useNavigationBuilder<
    TabNavigationState<ParamListBase>,
    TabRouterOptions,
    TabActionHelpers<ParamListBase>,
    OpcionesDeSeccion,
    EventosDeSeccion
  >
>;

/** Lo que necesita la barra flotante para pintarse. */
export type PropsDeBarra = Pick<Constructor, 'state' | 'descriptors' | 'navigation'>;

type PropsDeVista = PropsDeBarra & {
  barra: (props: PropsDeBarra) => React.ReactNode;
};

function VistaDeSecciones({ state, descriptors, navigation, barra }: PropsDeVista) {
  /*
    El ancho lo manda la ventana, no una constante: cada pagina ocupa una
    pantalla y el calculo tiene que seguir siendo correcto en un movil
    estrecho, en una tablet y al girar el aparato.
  */
  const { width: ancho } = useWindowDimensions();

  const rutaActual = state.routes[state.index];
  const posicionActual = rutaActual ? posicionDeSeccion(rutaActual.name) : -1;
  /*
    Hay destinos dentro de las pestanas que no son seccion. Ahi el carrusel no
    pinta ni escucha: se muestra esa pantalla y punto.
  */
  const enSeccion = posicionActual >= 0;
  const ultimaPosicion = ORDEN_SECCIONES.length - 1;

  /*
    Las rutas de seccion, ALINEADAS con `ORDEN_SECCIONES`.

    Sin filtrar los huecos a proposito: `posicionActual` es un indice sobre
    `ORDEN_SECCIONES`, asi que si aqui se compactara la lista al faltar una
    seccion, los dos indices dejarian de referirse a lo mismo y el carrusel
    llevaria a la pantalla equivocada. Hoy estan siempre las cinco, pero eso es
    una casualidad del momento, no una garantia.
  */
  const paginas = useMemo(
    () => ORDEN_SECCIONES.map((nombre) => state.routes.find((ruta) => ruta.name === nombre)),
    [state.routes],
  );

  /*
    Que secciones existen ya en memoria.

    Una vez montada, una seccion NO se desmonta: es lo que evita que ir y
    volver entre pestanas repita las llamadas a la API y pierda el scroll, el
    buscador o la publicacion abierta. Se guarda por clave de ruta, no por
    indice, porque los indices se mueven.
  */
  const [montadas, setMontadas] = useState<ReadonlySet<string>>(
    () => new Set(rutaActual ? [rutaActual.key] : []),
  );

  const marcarMontadas = useCallback((claves: readonly string[]) => {
    setMontadas((previas) => {
      const faltan = claves.filter((clave) => !previas.has(clave));
      if (!faltan.length) return previas;
      const siguiente = new Set(previas);
      faltan.forEach((clave) => siguiente.add(clave));
      return siguiente;
    });
  }, []);

  // La actual, siempre y de inmediato.
  useEffect(() => {
    if (rutaActual) marcarMontadas([rutaActual.key]);
  }, [rutaActual, marcarMontadas]);

  // Las vecinas, un momento despues (ver ESPERA_PARA_PREPARAR_VECINAS).
  useEffect(() => {
    if (!enSeccion) return;
    const vecinas = [paginas[posicionActual - 1]?.key, paginas[posicionActual + 1]?.key].filter(
      (clave): clave is string => !!clave,
    );
    if (!vecinas.length) return;
    const temporizador = setTimeout(() => marcarMontadas(vecinas), ESPERA_PARA_PREPARAR_VECINAS);
    return () => clearTimeout(temporizador);
  }, [enSeccion, paginas, posicionActual, marcarMontadas]);

  /*
    QUIEN COLOCA QUE.

    La pagina en la que estamos la decide REACT: cada seccion se coloca en
    `(su posicion - la actual) * ancho`, asi que la actual cae siempre en cero y
    sus vecinas justo a los lados. Reanimated no interviene en eso.

    El arrastre lo lleva REANIMATED: `desplazamiento` es SOLO lo que ha corrido
    el dedo, y vale cero en reposo.

    Al principio lo llevaba todo Reanimated en un unico valor absoluto, que
    sobre el papel evitaba tener que poner nada a cero al cambiar de ruta. En la
    practica no funcionaba: al pulsar una pestana el valor se actualizaba
    correctamente (-375) pero la transformacion del DOM se quedaba clavada en
    cero, de modo que la seccion nueva quedaba fuera de pantalla. Repartirlo asi
    ademas es mas honesto: en que seccion estamos es estado de navegacion, no
    una animacion.
  */
  const desplazamiento = useSharedValue(0);
  /** Hay un ajuste en curso: se ignoran gestos nuevos hasta que termine. */
  const ajustando = useSharedValue(false);

  /*
    Al cambiar de seccion —por el dedo, por la barra, por el boton Atras— el
    arrastre vuelve a cero.

    `useLayoutEffect` y no `useEffect` a proposito: tiene que ocurrir en el
    MISMO fotograma en el que React recoloca las paginas. Con el efecto normal
    hay un instante en que las paginas ya estan en su sitio nuevo pero el
    desplazamiento sigue puesto, y eso se ve como un salto.
  */
  useLayoutEffect(() => {
    desplazamiento.value = 0;
    ajustando.value = false;
  }, [posicionActual, ancho, desplazamiento, ajustando]);

  const irASeccion = useCallback(
    (paso: 1 | -1) => {
      const destino = paginas[posicionActual + paso];
      ajustando.value = false;
      if (destino) navigation.navigate(destino.name);
    },
    [paginas, posicionActual, navigation, ajustando],
  );

  const gesto = useMemo(() => {
    const hayAnterior = posicionActual > 0;
    const haySiguiente = posicionActual < ultimaPosicion && posicionActual >= 0;

    return (
      Gesture.Pan()
        // En un destino que no es seccion no hay carrusel que mover.
        .enabled(enSeccion)
        /*
          El muro se lee en VERTICAL. La duda se resuelve siempre a favor del
          desplazamiento: hacen falta 20 px claros en horizontal, y basta con
          18 px verticales para descartar el cambio de seccion. Es lo que evita
          que bajar el feed en diagonal acabe en otra pestana.
        */
        .activeOffsetX([-MARGEN_HORIZONTAL, MARGEN_HORIZONTAL])
        .failOffsetY([-MARGEN_VERTICAL, MARGEN_VERTICAL])
        .onUpdate((evento) => {
          if (ajustando.value) return;
          const haciaSiguiente = evento.translationX < 0;
          const sinSalida = haciaSiguiente ? !haySiguiente : !hayAnterior;
          // En el borde el recorrido se frena en vez de bloquearse en seco.
          desplazamiento.value =
            evento.translationX * (sinSalida ? RESISTENCIA_EN_EL_BORDE : 1);
        })
        .onEnd((evento) => {
          if (ajustando.value) return;
          const haciaSiguiente = evento.translationX < 0;
          const sinSalida = haciaSiguiente ? !haySiguiente : !hayAnterior;
          /*
            Distancia O velocidad, no solo distancia: un golpe corto y rapido
            es una forma legitima de pasar de pagina y exigirle un tercio de la
            pantalla lo haria sentir pesado.
          */
          const decidido =
            Math.abs(evento.translationX) > ancho * UMBRAL_DISTANCIA ||
            Math.abs(evento.velocityX) > UMBRAL_VELOCIDAD;

          if (sinSalida || !decidido) {
            desplazamiento.value = withTiming(0, REGRESO);
            return;
          }

          ajustando.value = true;
          desplazamiento.value = withTiming(
            haciaSiguiente ? -ancho : ancho,
            AJUSTE,
            (terminado) => {
              /*
                La ruta se confirma UNA sola vez, aqui, cuando la transicion ya
                se acepto. Durante el arrastre no se toca el router: eso seria
                navegar decenas de veces por segundo.
              */
              if (terminado) runOnJS(irASeccion)(haciaSiguiente ? 1 : -1);
              else ajustando.value = false;
            },
          );
        })
        /*
          Si el sistema cancela el gesto (una llamada entrante, un dialogo), la
          pantalla no puede quedarse a medio camino.
        */
        .onFinalize((_evento, exito) => {
          if (!exito && !ajustando.value) desplazamiento.value = withTiming(0, REGRESO);
        })
    );
  }, [posicionActual, ancho, ultimaPosicion, enSeccion, desplazamiento, ajustando, irASeccion]);

  const estiloDelCarrusel = useAnimatedStyle(() => ({
    transform: [{ translateX: desplazamiento.value }],
  }));

  const propsDeBarra: PropsDeBarra = { state, descriptors, navigation };

  return (
    <ProveedorDeGestoDeSeccion gesto={gesto}>
      <View style={styles.lleno}>
        {/*
          VENTANA QUE RECORTA. Quieta, nunca se mueve, y es lo unico que se ve.

          Sin ella, las secciones vecinas —que estan colocadas a un ancho de
          pantalla a cada lado— quedaban dibujadas FUERA del contenedor, y el
          documento pasaba a medir cinco pantallas de ancho (1875 px en un movil
          de 375). Con un documento mas ancho que la ventana, el navegador del
          telefono se cree con derecho a desplazarlo en horizontal, asi que al
          arrastrar movia la PAGINA ENTERA en vez de solo el carrusel: la barra
          inferior se iba con el contenido y la seccion vecina aparecia sin
          barra encima. Recortando aqui, el documento nunca es mas ancho que la
          pantalla, no hay nada que el navegador pueda desplazar, y lo unico que
          se mueve es el carrusel de dentro.

          Tambien hace falta en movil nativo: iOS no recorta por defecto.
        */}
        <View style={styles.ventana}>
        <GestureDetector
          gesture={gesto}
          /*
            Solo navegador: el desplazamiento vertical lo sigue llevando el, del
            horizontal nos encargamos nosotros, y el texto de las publicaciones
            se puede seguir seleccionando (la libreria lo desactiva por defecto).
          */
          touchAction="pan-y"
          userSelect="auto"
        >
          <Animated.View
            style={[styles.carrusel, estiloDelCarrusel]}
            collapsable={false}
            pointerEvents={enSeccion ? 'auto' : 'none'}
          >
            {paginas.map((ruta, posicion_) => {
              if (!ruta || !montadas.has(ruta.key)) return null;
              const esActual = enSeccion && posicion_ === posicionActual;
              const esVecina = enSeccion && Math.abs(posicion_ - posicionActual) === 1;
              return (
                <View
                  key={ruta.key}
                  /*
                    Relativa a la seccion actual: la actual en cero, la anterior
                    a -ancho y la siguiente a +ancho. Asi basta con arrastrar el
                    contenedor para descubrir la de al lado, y no hay que mover
                    nada cuando se cambia de pestana pulsando.
                  */
                  style={[
                    styles.pagina,
                    { width: ancho, left: (posicion_ - Math.max(posicionActual, 0)) * ancho },
                  ]}
                  /*
                    Lo que no se ve no recibe toques aunque este montado y a un
                    lado; si no, un dedo cerca del borde podria pulsar un boton
                    de la seccion de al lado.
                  */
                  pointerEvents={esActual ? 'auto' : 'none'}
                  accessibilityElementsHidden={!esActual}
                  importantForAccessibility={esActual ? 'auto' : 'no-hide-descendants'}
                >
                  {/*
                    Congelada todo lo que no sea la seccion actual ni sus dos
                    vecinas. Es el mismo criterio que traia `freezeOnBlur`: sin
                    esto, dar un "me gusta" recalcula las veinte tarjetas del
                    muro aunque estes en Explorar, y ese trabajo cae en el mismo
                    hilo que anima el arrastre.

                    Las vecinas se quedan vivas a proposito: son las que tienen
                    que aparecer ya dibujadas en cuanto el dedo se mueva, y
                    descongelarlas en ese instante costaria un repintado justo
                    cuando menos sobra.
                  */}
                  <Freeze freeze={!esActual && !esVecina}>{descriptors[ruta.key]?.render()}</Freeze>
                </View>
              );
            })}
          </Animated.View>
        </GestureDetector>
        </View>

        {/*
          Destino que no es seccion (perfil ajeno, circulo, audio, seguidores).
          Se pinta encima, a pantalla completa, y el carrusel queda detras sin
          recibir toques. La barra sigue debajo, como hasta ahora.
        */}
        {!enSeccion && rutaActual ? (
          <View style={StyleSheet.absoluteFill}>{descriptors[rutaActual.key]?.render()}</View>
        ) : null}

        {barra(propsDeBarra)}
      </View>
    </ProveedorDeGestoDeSeccion>
  );
}

function NavegadorDeSecciones({
  initialRouteName,
  backBehavior,
  screenOptions,
  children,
  barra,
}: {
  initialRouteName?: string;
  backBehavior?: TabRouterOptions['backBehavior'];
  screenOptions?: OpcionesDeSeccion;
  children: React.ReactNode;
  barra: (props: PropsDeBarra) => React.ReactNode;
}) {
  const { state, descriptors, navigation, NavigationContent } = useNavigationBuilder<
    TabNavigationState<ParamListBase>,
    TabRouterOptions,
    TabActionHelpers<ParamListBase>,
    OpcionesDeSeccion,
    EventosDeSeccion
  >(TabRouter, {
    initialRouteName,
    backBehavior,
    screenOptions,
    children,
  });

  return (
    <NavigationContent>
      <VistaDeSecciones
        state={state}
        descriptors={descriptors}
        navigation={navigation}
        barra={barra}
      />
    </NavigationContent>
  );
}

export const createSwipeTabNavigator = createNavigatorFactory(NavegadorDeSecciones);

const styles = StyleSheet.create({
  lleno: { flex: 1 },
  /*
    La barra flotante va FUERA de esta ventana (es hermana suya y se pinta
    despues), asi que se queda fija encima mientras las secciones pasan por
    debajo. Es justo lo que hacen las aplicaciones de referencia: lo que cambia
    es el contenido, nunca la barra.
  */
  ventana: { flex: 1, overflow: 'hidden' },
  carrusel: { flex: 1 },
  pagina: { position: 'absolute', top: 0, bottom: 0 },
});
