import React, { useCallback, useEffect, useState } from 'react';
import { LayoutChangeEvent, ScrollView, StyleSheet, View, ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { MUELLE_DE_PANEL } from '@/lib/movimiento';
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

type Medida = { x: number; ancho: number };

/**
 * Pestañas con una raya que VIAJA a la pestaña elegida.
 *
 * Antes cada pestaña pintaba su propia raya y al cambiar una se apagaba y otra
 * se encendía. Ahora hay una sola, que se desliza y cambia de ancho: se ve a
 * dónde se ha ido. Cada pestaña dice dónde está (`onLayout`) y la raya va a
 * esa medida; mientras no la hay, no se pinta.
 */
export function Tabs({ tabs, activeTab, onChangeTab, scrollable = false, style }: TabsProps) {
  const { colors } = useAppTheme();
  const reducir = useReducedMotion();
  const [medidas, setMedidas] = useState<Record<string, Medida>>({});
  const x = useSharedValue(0);
  const ancho = useSharedValue(0);
  const activa = medidas[activeTab];

  useEffect(() => {
    if (!activa) return;
    // La primera vez aparece en su sitio; después viaja.
    const primera = ancho.value === 0;
    if (reducir || primera) {
      x.value = activa.x;
      ancho.value = activa.ancho;
      return;
    }
    x.value = withSpring(activa.x, MUELLE_DE_PANEL);
    ancho.value = withSpring(activa.ancho, MUELLE_DE_PANEL);
  }, [activa, x, ancho, reducir]);

  const raya = useAnimatedStyle(() => ({
    width: ancho.value,
    transform: [{ translateX: x.value }],
  }));

  const medir = useCallback((tab: string, evento: LayoutChangeEvent) => {
    const { x: posicion, width } = evento.nativeEvent.layout;
    setMedidas((previas) => {
      const antes = previas[tab];
      if (antes && antes.x === posicion && antes.ancho === width) return previas;
      return { ...previas, [tab]: { x: posicion, ancho: width } };
    });
  }, []);

  const content = (
    <View style={[styles.tabsWrapper, !scrollable && styles.tabsWrapperFlex]}>
      {tabs.map((tab) => {
        const active = tab === activeTab;
        return (
          <Pulsable
            key={tab}
            onPress={() => onChangeTab(tab)}
            onLayout={(evento) => medir(tab, evento)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={tab}
            atenuar={0.7}
            style={[styles.tab, !scrollable && styles.tabFlex]}
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
          </Pulsable>
        );
      })}
      {activa ? (
        <Animated.View
          pointerEvents="none"
          style={[styles.raya, { backgroundColor: colors.primary }, raya]}
        />
      ) : null}
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
    paddingHorizontal: spacing.md,
  },
  tabFlex: {
    flex: 1,
  },
  tabLabel: {
    fontSize: 14,
  },
  raya: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    height: 2,
    borderRadius: 1,
  },
});
