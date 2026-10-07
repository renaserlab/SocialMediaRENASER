import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { withLayoutContext } from 'expo-router';

import { FloatingGlassTabBar } from '@/components/FloatingGlassTabBar';
import { ProveedorDeEspacioInferior } from '@/components/espacioInferior';
import { useHaceFaltaCuenta } from '@/hooks/useRequireAuth';
import { traeSuPropiaBarra } from '@/navigation/secciones';
import { createSwipeTabNavigator, type PropsDeBarra } from '@/navigation/SwipeTabs';
import { useTranslation } from '@/i18n/useTranslation';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useAppTheme } from '@/theme/useAppTheme';

/*
  Las pestañas ya no las pinta el navegador de abajo de React Navigation, sino
  uno propio que coloca las secciones en un carrusel para que la pantalla siga
  al dedo (ver `src/navigation/SwipeTabs.tsx`, donde esta explicado por que).

  Lo que NO cambia: sigue siendo expo-router, sigue siendo el mismo `TabRouter`
  —asi que el historial entre pestañas y el `backBehavior` se comportan igual—,
  y las rutas del directorio se auto-registran exactamente como antes, con lo
  que ninguna URL se mueve.
*/
const { Navigator } = createSwipeTabNavigator();
const Secciones = withLayoutContext(Navigator);

export default function TabsLayout() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();

  const hydrated = useAppStore((state) => state.hydrated);
  const authStatus = useAuthStore((state) => state.status);
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const haceFaltaCuenta = useHaceFaltaCuenta();

  // Mismo criterio que app/index.tsx: no se decide nada hasta saber si hay
  // sesion, o cada arranque rebotaria a la bienvenida antes de resolverla.
  if (!hydrated || (supabaseEnabled && authStatus === 'loading')) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.background,
        }}
      >
        <ActivityIndicator color={colors.text} />
      </View>
    );
  }

  /*
    Ya no hay guarda de sesion aqui.

    Estas pestañas se pueden recorrer sin cuenta: se ve el muro, se explora y se
    entra en los perfiles, como en TikTok. Lo que pide cuenta es actuar
    —publicar, comentar, reaccionar, guardar—, y eso se comprueba en cada
    accion (`useRequireAuth`), no al entrar.

    Ademas, mientras estuvo aqui la comprobacion, la aplicacion se quedaba en
    blanco: la raiz mandaba al muro y el muro devolvia a la raiz, en un ida y
    vuelta sin fin del que no salia ninguna pantalla.

    Lo que de verdad protege los datos es el servidor: sin token, la API no
    devuelve nada privado.
  */

  return (
    /*
      Cuanto ocupa la capsula flotante, publicado para todo lo que viva dentro
      de las pestañas.

      La barra se pinta ENCIMA de las secciones y ademas se queda el toque, asi
      que cualquier control pegado al borde inferior —el boton de publicar, el
      disparador de la camara— tiene que apartarse de ella. Antes cada pantalla
      lo resolvia con un numero escrito a mano, y todos distintos: de ahi que el
      boton de publicar quedara tapado en seis flujos a la vez. Ahora el dato
      sale de un solo sitio y se pide con `useEspacioInferior()`.
    */
    <ProveedorDeEspacioInferior>
    <Secciones
      /*
        Barra propia: capsula flotante con acabado de vidrio. Ahora la pinta el
        navegador como ultimo hijo, por encima del carrusel, para que no se
        mueva con el: la barra se queda quieta mientras las secciones pasan por
        debajo, que es como se comporta en las aplicaciones de referencia.
      */
      /*
        EN CREAR NO SE PINTA. Su sitio lo ocupa la barra de los tipos de
        publicacion (`SelectorDeModo`), que es de la misma familia: con las
        dos a la vez no se sabria cual es cual.

        Sin cuenta si se pinta: Crear ensena entonces la invitacion a
        registrarse, no su barra, y sin esta no habria por donde salir. Es la
        misma pregunta que se hace `CrearScreen` (`useHaceFaltaCuenta`), para
        que no pueda quitarse una barra sin que aparezca la otra.
      */
      barra={(props: PropsDeBarra) =>
        traeSuPropiaBarra(props.state.routes[props.state.index]?.name) && !haceFaltaCuenta ? null : (
          <FloatingGlassTabBar {...props} />
        )
      }
      /*
        Atras vuelve a la pestaña ANTERIOR, no siempre a Inicio.

        Por omision React Navigation usa `firstRoute`: desde cualquier pestaña,
        Atras saltaba directamente a Inicio y la siguiente pulsacion cerraba la
        aplicacion, perdiendo por el camino todo lo que la persona habia
        recorrido. Con `history` el propio TabRouter guarda el orden de visita y
        deshace paso a paso —Explorar → Perfil → Inicio—.

        Es el mecanismo de la libreria, no un historial nuestro en paralelo:
        vale igual para el gesto, para la barra y para un enlace externo. Que
        el carrusel use ESE MISMO router es justo lo que evita que deslizar y
        pulsar acaben contando historias distintas.
      */
      backBehavior="history"
    >
      <Secciones.Screen name="home" options={{ title: t('tabs.home') }} />
      <Secciones.Screen name="explore" options={{ title: t('tabs.explore') }} />
      <Secciones.Screen name="create" options={{ title: t('tabs.create') }} />
      <Secciones.Screen name="messages" options={{ title: t('tabs.messages') }} />
      <Secciones.Screen name="profile/index" options={{ title: t('tabs.profile') }} />

      {/*
        Las demas rutas del directorio (perfil ajeno, circulo, audio, seguidores,
        seguidos) se auto-registran solas y NO hace falta declararlas.

        Antes llevaban `href: null` para que el navegador de abajo no les pusiera
        boton en la barra. Ya no hace falta: la barra pinta exactamente las cinco
        secciones de `navigation/secciones.ts` y nada mas. Y el carrusel usa esa
        misma lista, de modo que estas rutas quedan fuera de el por construccion:
        deslizar desde Perfil no puede acabar en el perfil de un desconocido sin
        parametros. Siguen viviendo aqui dentro, que es lo que mantiene la barra
        visible al abrirlas.
      */}
    </Secciones>
    </ProveedorDeEspacioInferior>
  );
}
