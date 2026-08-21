import 'react-native-gesture-handler';
import React, { useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { Stack, type ErrorBoundaryProps } from 'expo-router';
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
import { DialogHost } from '@/components/DialogHost';
import { ToastHost } from '@/components/ToastHost';
import { useAuthDeepLink } from '@/hooks/useAuthDeepLink';
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

  // Inicializa la sesion de Supabase (restaura usuario autenticado si lo hay).
  useEffect(() => {
    void useAuthStore.getState().bootstrap();
  }, []);

  // Atiende los enlaces del correo (recuperar contrasena) en movil. Va en la
  // raiz porque el enlace puede llegar con cualquier pantalla delante, o con la
  // aplicacion cerrada.
  useAuthDeepLink();

  // Boton fisico Atras de Android: primero retrocede de verdad y, ya en la
  // raiz, avisa antes de cerrar en vez de salir de golpe. Va en la raiz porque
  // el boton existe en toda la aplicacion, no solo en las pestañas.
  useSalidaConDoblePulsacion();

  // El segundo valor es el error de carga: si la fuente falla (sin red, cache
  // vacia) hay que continuar igualmente con la tipografia del sistema.
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Inter_800ExtraBold,
    Inter_900Black,
  });

  // Red de seguridad: pase lo que pase, la app se muestra a los 3 s. Evita que
  // un fallo de hidratacion o de fuentes deje al usuario en el splash para siempre.
  const [bootTimedOut, setBootTimedOut] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setBootTimedOut(true), 3000);
    return () => clearTimeout(timer);
  }, []);

  const fontsReady = fontsLoaded || !!fontError;
  const ready = (hydrated && fontsReady) || bootTimedOut;

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
        <Stack
          screenOptions={{ headerShown: false, animation: 'slide_from_right', animationDuration: 220 }}
        />
        {/* Dialogo de confirmaciones y avisos: uno solo para toda la app. */}
        <DialogHost />
        {/* Toast de exito. Va despues para quedar por encima del dialogo. */}
        <ToastHost />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
