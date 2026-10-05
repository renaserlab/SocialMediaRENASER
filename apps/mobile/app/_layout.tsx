import 'react-native-gesture-handler';
import React, { useEffect, useState } from 'react';
import { Appearance, Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { Stack, usePathname, type ErrorBoundaryProps } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
  Inter_900Black,
} from '@expo-google-fonts/inter';

import { AppErrorFallback } from '@/components/AppErrorFallback';
import { AvisoDeDirectoSeguido } from '@/components/AvisoDeDirectoSeguido';
import { DialogHost } from '@/components/DialogHost';
import { LimiteDeErrores } from '@/components/LimiteDeErrores';
import { ToastHost } from '@/components/ToastHost';
import { useAuthDeepLink } from '@/hooks/useAuthDeepLink';
import { useAbrirDesdeElPush } from '@/hooks/useAbrirDesdeElPush';
import { useAvisosDelPush } from '@/hooks/useAvisosDelPush';
import { useAvisosEnVivo } from '@/hooks/useAvisosEnVivo';
import { useNavegadorMontado } from '@/hooks/useNavegadorMontado';
import { useSalidaConDoblePulsacion } from '@/hooks/useSalidaConDoblePulsacion';
import { perfMark } from '@/lib/perf';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';

/**
 * Red de seguridad para toda la aplicacion.
 *
 * expo-router llama a este componente cuando una pantalla falla al dibujarse.
 * Sin el, ese fallo dejaba la aplicacion en blanco, sin explicacion y sin
 * salida: habia que cerrarla y volver a abrirla. Al declararlo en la raiz
 * cubre todas las rutas.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <AppErrorFallback error={error} retry={retry} />;
}

SplashScreen.preventAutoHideAsync();
SplashScreen.setOptions({ duration: 450, fade: true });

export default function RootLayout() {
  const hydrated = useAppStore((state) => state.hydrated);
  const mode = useAppStore((state) => state.themeMode);
  // Para decir en qué pantalla ocurrió un fallo (`LimiteDeErrores`).
  const ruta = usePathname();

  // Inicializa la sesion de Supabase (restaura usuario autenticado si lo hay).
  useEffect(() => {
    void useAuthStore.getState().bootstrap();
  }, []);

  /*
    EL TEMA DE LA APLICACION MANDA TAMBIEN EN LAS PANTALLAS DEL SISTEMA.

    Z tiene su propio interruptor claro/oscuro (`themeMode`), pero hay trozos de
    interfaz que no dibuja React: el recortador de fotos que abre
    `expo-image-picker` al subir una imagen —con sus opciones «Gira
    horizontalmente» y «Gira verticalmente»—, los selectores de fecha y el
    aspecto del teclado. Todo eso elige sus colores por la configuracion NATIVA
    (en Android, los recursos `values` frente a `values-night`), que hasta ahora
    seguia al telefono y no a la aplicacion. Resultado: con la app en claro y el
    telefono en oscuro —o al reves— esos textos salian con el fondo cambiado.

    `Appearance.setColorScheme` es justo la pieza que faltaba: fija el modo
    nativo al que dice el tema de la aplicacion, asi que esas pantallas resuelven
    el mismo juego de colores. No se pinta nada a mano ni se fija ningun blanco:
    se le dice al sistema cual es el tema y el resto sale solo.

    En web no existe (y no hace falta: alli no hay recortador nativo).
  */
  useEffect(() => {
    if (Platform.OS === 'web') return;
    Appearance.setColorScheme?.(mode);
  }, [mode]);

  // Boton fisico Atras de Android: primero retrocede de verdad y, ya en la
  // raiz, avisa antes de cerrar en vez de salir de golpe. Va en la raiz porque
  // el boton existe en toda la aplicacion, no solo en las pestañas.
  useSalidaConDoblePulsacion();

  // Los avisos con la aplicacion ABIERTA: el push que llega en primer plano y,
  // sin depender de el, los mensajes en vivo y la lectura periodica de la
  // bandeja. Los dos acaban en el mismo aviso flotante.
  useAvisosDelPush();
  useAvisosEnVivo();

  /*
    El segundo valor es el error de carga: si la fuente falla (sin red, cache
    vacia) hay que continuar igualmente con la tipografia del sistema.

    EN iOS NO SE CARGA NINGUNA, y no es un olvido: `theme/tokens.ts` devuelve
    'System' —San Francisco— para los seis pesos cuando `Platform.OS` es
    'ios'. Ni un solo texto de la aplicacion pide Inter alli. Aun asi se
    registraban las seis, y el splash ESPERABA a que terminaran: seis ficheros
    de ~165 KB leidos y registrados para no pintar con ellos ni una letra.

    En web y Android si se usan, asi que alli se cargan igual que siempre.
  */
  const [fontsLoaded, fontError] = useFonts(
    Platform.OS === 'ios'
      ? {}
      : {
          Inter_400Regular,
          Inter_500Medium,
          Inter_600SemiBold,
          Inter_700Bold,
          Inter_800ExtraBold,
          Inter_900Black,
        },
  );

  // Red de seguridad: pase lo que pase, la app se muestra a los 3 s. Evita que
  // un fallo de hidratacion o de fuentes deje al usuario en el splash para siempre.
  const [bootTimedOut, setBootTimedOut] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setBootTimedOut(true), 3000);
    return () => clearTimeout(timer);
  }, []);

  const fontsReady = fontsLoaded || !!fontError;
  const ready = (hydrated && fontsReady) || bootTimedOut;

  /*
    LOS DOS GANCHOS QUE NAVEGAN POR SU CUENTA, Y CUÁNDO PUEDEN HACERLO.

    Mientras `ready` es falso este layout devuelve `null`: no hay `<Stack>`.
    Navegar en ese hueco volvía a montar el layout entero y, con un toque de
    notificación pendiente, lo hacía en bucle: la aplicación dejaba de abrirse
    (05/10/2026). La señal de que se puede es que el navegador de la aplicación
    esté montado DE VERDAD, y es una sola para los dos.
    Ver `lib/navegadorMontado.ts`.
  */
  const navegadorMontado = useNavegadorMontado(ready);
  // Atiende los enlaces del correo (recuperar contrasena) en movil. Va en la
  // raiz porque el enlace puede llegar con cualquier pantalla delante, o con la
  // aplicacion cerrada.
  useAuthDeepLink(navegadorMontado);
  // Tocar un push lleva a lo que anuncia. En la raiz porque el push puede abrir
  // la aplicacion desde cerrada, con cualquier pantalla por debajo.
  useAbrirDesdeElPush(navegadorMontado);

  useEffect(() => {
    if (hydrated) perfMark('STORE_HYDRATED');
  }, [hydrated]);

  useEffect(() => {
    if (ready) {
      perfMark('SHELL_VISIBLE');
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [ready]);

  if (!ready) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
        {/*
          Lo que falle en cualquier pantalla —o en los avisos de abajo, que
          están siempre montados— se recoge AQUÍ, antes que en la red de
          expo-router de arriba: este límite sabe en qué componente ocurrió.
        */}
        <LimiteDeErrores ruta={ruta}>
          <Stack
            screenOptions={{ headerShown: false, animation: 'slide_from_right', animationDuration: 220 }}
          />
          {/*
            «Juan está transmitiendo en vivo» al entrar, como en TikTok. Antes que
            el dialogo y el toast para quedar por debajo de ellos.
          */}
          <AvisoDeDirectoSeguido />
          {/* Dialogo de confirmaciones y avisos: uno solo para toda la app. */}
          <DialogHost />
          {/* Toast de exito. Va despues para quedar por encima del dialogo. */}
          <ToastHost />
        </LimiteDeErrores>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
