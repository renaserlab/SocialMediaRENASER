import { PropsWithChildren } from 'react';
import { ScrollView, ScrollViewProps, StyleProp, View, ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAppTheme } from '@/theme/useAppTheme';

type AppScreenProps = PropsWithChildren<{
  scroll?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  edges?: Array<'top' | 'right' | 'bottom' | 'left'>;
  scrollProps?: ScrollViewProps;
}>;

export function AppScreen({
  children,
  scroll = true,
  contentStyle,
  // Por defecto NO se aplica el inset superior: la mayoria de pantallas llevan
  // <AppHeader/> encima, que ya lo respeta. Las pantallas sin header deben pasar
  // edges={['top','left','right']} explicitamente.
  edges = ['left', 'right'],
  scrollProps,
}: AppScreenProps) {
  const { colors } = useAppTheme();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={edges}>
      {scroll ? (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[{ flexGrow: 1 }, contentStyle]}
          {...scrollProps}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1 }, contentStyle]}>{children}</View>
      )}
    </SafeAreaView>
  );
}
