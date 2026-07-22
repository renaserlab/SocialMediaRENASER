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

  // Con sesión activa se va directo al home; el quiz/registro es solo para
  // usuarios nuevos o anónimos (evita quedar atrapado en el flujo de onboarding).
  if (authStatus === 'authenticated') return <Redirect href="/(tabs)/home" />;
  if (onboardingComplete) return <Redirect href="/(tabs)/home" />;
  if (!languageSelected) return <Redirect href="/language" />;
  return <LandingScreen />;
}
