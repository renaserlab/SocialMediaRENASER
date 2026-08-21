import React from 'react';
import { Pressable, ScrollView, StyleSheet, View, ViewStyle } from 'react-native';

import { Text } from '@/components/Text';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { SinCambioDeSeccion } from '@/navigation/tabSwipe';

type TabsProps = {
  tabs: string[];
  activeTab: string;
  onChangeTab: (tab: string) => void;
  scrollable?: boolean;
  style?: ViewStyle;
};

export function Tabs({ tabs, activeTab, onChangeTab, scrollable = false, style }: TabsProps) {
  const { colors } = useAppTheme();

  const content = (
    <View style={[styles.tabsWrapper, !scrollable && styles.tabsWrapperFlex]}>
      {tabs.map((tab) => {
        const active = tab === activeTab;
        return (
          <Pressable
            key={tab}
            onPress={() => onChangeTab(tab)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={tab}
            style={({ pressed }: { pressed: boolean }) => [
              styles.tab,
              !scrollable && styles.tabFlex,
              {
                borderBottomColor: active ? colors.primary : 'transparent',
                opacity: pressed ? 0.8 : 1,
              },
            ]}
          >
            <Text
              style={[
                styles.tabLabel,
                {
                  color: active ? colors.text : colors.textMuted,
                  fontWeight: active ? '700' : '500',
                },
              ]}
            >
              {tab}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );

  if (scrollable) {
    return (
      /* Blindado frente al gesto de cambiar de seccion: ver tabSwipe.tsx. */
      <SinCambioDeSeccion>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[styles.scrollContainer, style]}
        >
          {content}
        </ScrollView>
      </SinCambioDeSeccion>
    );
  }

  return <View style={[styles.container, style]}>{content}</View>;
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  scrollContainer: {
    width: '100%',
  },
  tabsWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  tabsWrapperFlex: {
    justifyContent: 'space-between',
    width: '100%',
  },
  tab: {
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 2,
    paddingHorizontal: spacing.md,
  },
  tabFlex: {
    flex: 1,
  },
  tabLabel: {
    fontSize: 14,
  },
});
