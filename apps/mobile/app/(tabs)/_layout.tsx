import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Tabs } from 'expo-router';

import { FloatingGlassTabBar } from '@/components/FloatingGlassTabBar';
import { CambioDeSeccionPorGesto } from '@/navigation/tabSwipe';
import { useTranslation } from '@/i18n/useTranslation';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useAppTheme } from '@/theme/useAppTheme';

const icon = (name: keyof typeof Feather.glyphMap) => ({ color, size }: { color: string; size: number }) => (
  <Feather name={name} color={color} size={size} />
);

export default function TabsLayout() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();

  const hydrated = useAppStore((state) => state.hydrated);
  const authStatus = useAuthStore((state) => state.status);
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);

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
      Arrastrar en horizontal cambia de seccion, como en Facebook o Instagram.
      No es un segundo navegador: el gesto acaba llamando a lo MISMO que pulsar
      la barra de abajo, asi que barra y gesto no pueden desincronizarse. El
      detalle esta en `src/navigation/tabSwipe.tsx`.
    */
    <CambioDeSeccionPorGesto>
    <Tabs
      /*
        Barra propia: capsula flotante con acabado de vidrio (ver
        FloatingGlassTabBar). Las rutas y los `href: null` de abajo no cambian;
        solo cambia quien pinta la barra.
      */
      tabBar={(props) => <FloatingGlassTabBar {...props} />}
      /*
        Atras vuelve a la pestaña ANTERIOR, no siempre a Inicio.

        Por omision React Navigation usa `firstRoute`: desde cualquier pestaña,
        Atras saltaba directamente a Inicio y la siguiente pulsacion cerraba la
        aplicacion, perdiendo por el camino todo lo que la persona habia
        recorrido. Con `history` el propio TabRouter guarda el orden de visita y
        deshace paso a paso —Explorar → Perfil → Inicio—, que es justo lo que
        pedia el documento.

        Es el mecanismo de la libreria, no un historial nuestro en paralelo:
        vale igual para el gesto, para la barra y para un enlace externo.
      */
      backBehavior="history"
      screenOptions={{
        headerShown: false,
        /*
          Congela las pestanas que no se ven.

          React Navigation mantiene montada cada pestana ya visitada, asi que
          sin esto un solo cambio del estado global re-renderiza TODAS: das un
          "me gusta" y se recalculan las veinte tarjetas del muro aunque estes
          en Explorar. Ese trabajo ocurre en el hilo de JavaScript, el mismo que
          anima la transicion, y de ahi el tiron al cambiar de pestana.

          Congelada, una pantalla deja de renderizar hasta que vuelve a verse.
          Es seguro para lo que hay hoy: la cuenta atras del podcast se calcula
          desde `Date.now()` en cada tick, no acumula, asi que al descongelarse
          muestra el valor correcto. Ojo si algun dia se anade algo que dependa
          de seguir contando en segundo plano.
        */
        freezeOnBlur: true,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
      }}
    >
      <Tabs.Screen name="home" options={{ title: t('tabs.home'), tabBarIcon: icon('home') }} />
      <Tabs.Screen name="explore" options={{ title: t('tabs.explore'), tabBarIcon: icon('search') }} />
      <Tabs.Screen name="create" options={{ title: t('tabs.create'), tabBarIcon: icon('plus-square') }} />
      <Tabs.Screen name="messages" options={{ title: t('tabs.messages'), tabBarIcon: icon('message-square') }} />
      <Tabs.Screen name="profile/index" options={{ title: t('tabs.profile'), tabBarIcon: icon('user') }} />

      {/*
        Pantallas que viven DENTRO del navegador de pestañas para que la barra
        inferior no desaparezca al abrirlas (antes colgaban de la raiz y se
        entraba en una vista sin salida visible). `href: null` las mantiene
        fuera de la barra: son destinos, no pestañas.

        El grupo `(tabs)` no aparece en la URL, asi que las rutas siguen siendo
        /profile/<id>, /circle/<id> y /audio/<id>.
      */}
      <Tabs.Screen name="profile/[id]" options={{ href: null }} />
      <Tabs.Screen name="circle/[id]" options={{ href: null }} />
      <Tabs.Screen name="audio/[id]" options={{ href: null }} />
      <Tabs.Screen name="followers/[id]" options={{ href: null }} />
      <Tabs.Screen name="following/[id]" options={{ href: null }} />
    </Tabs>
    </CambioDeSeccionPorGesto>
  );
}
