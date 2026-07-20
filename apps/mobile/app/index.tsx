import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';

import { LandingScreen } from '@/screens/LandingScreen';
import { useAppStore } from '@/store/useAppStore';
import { useAppTheme } from '@/theme/useAppTheme';

export default function IndexRoute() {
  const hydrated = useAppStore((state) => state.hydrated);
  const onboardingComplete = useAppStore((state) => state.onboardingComplete);
  const languageSelected = useAppStore((state) => state.languageSelected);
  const { colors } = useAppTheme();

  if (!hydrated) {
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background }}><ActivityIndicator color={colors.text} /></View>;
  }

  if (onboardingComplete) return <Redirect href="/(tabs)/home" />;
  if (!languageSelected) return <Redirect href="/language" />;
  return <LandingScreen />;
}
