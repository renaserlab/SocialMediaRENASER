import 'react-native-gesture-handler';
import React, { useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
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

import { DialogHost } from '@/components/DialogHost';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';

SplashScreen.preventAutoHideAsync();
SplashScreen.setOptions({ duration: 450, fade: true });

export default function RootLayout() {
  const hydrated = useAppStore((state) => state.hydrated);
  const mode = useAppStore((state) => state.themeMode);

  // Inicializa la sesion de Supabase (restaura usuario autenticado si lo hay).
  useEffect(() => {
    void useAuthStore.getState().bootstrap();
  }, []);

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
    if (ready) {
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
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
