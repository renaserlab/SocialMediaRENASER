import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';

import { LandingScreen } from '@/screens/LandingScreen';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useAppTheme } from '@/theme/useAppTheme';

export default function IndexRoute() {
  const hydrated = useAppStore((state) => state.hydrated);
  const onboardingComplete = useAppStore((state) => state.onboardingComplete);
  const languageSelected = useAppStore((state) => state.languageSelected);
  const authStatus = useAuthStore((state) => state.status);
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const { colors } = useAppTheme();

  // Espera a la hidratación del store y (si hay Supabase) a resolver la sesión,
  // para no mostrar el flujo de onboarding un instante antes de redirigir al home.
  const authResolving = supabaseEnabled && authStatus === 'loading';

  if (!hydrated || authResolving) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background }}>
        <ActivityIndicator color={colors.text} />
      </View>
    );
  }

  // Con sesión activa se va directo al home.
  if (authStatus === 'authenticated') return <Redirect href="/(tabs)/home" />;

  // Sin sesión y con backend real, manda la sesión y NO `onboardingComplete`:
  // esa marca vive en el dispositivo, no en la cuenta, asi que quien completó
  // el flujo alguna vez y luego cerró sesión (o se le caducó el token) volvía a
  // entrar como anónimo, saltándose el quiz y quedando atrapado en un perfil
  // sin datos. Se le devuelve a la bienvenida para que repita el recorrido:
  // idioma → quiz → resultado → registro.
  if (supabaseEnabled) {
    if (!languageSelected) return <Redirect href="/language" />;
    return <LandingScreen />;
  }

  // Modo demo (sin backend): no hay sesión que comprobar, así que la marca
  // local sigue siendo el único criterio.
  if (onboardingComplete) return <Redirect href="/(tabs)/home" />;
  if (!languageSelected) return <Redirect href="/language" />;
  return <LandingScreen />;
}
