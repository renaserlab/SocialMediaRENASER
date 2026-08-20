import React, { useEffect, useRef } from 'react';
import { Animated, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { BlurView } from 'expo-blur';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppStore } from '@/store/useAppStore';
import { getFontFamily, motion, radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Barra de pestañas flotante con acabado de vidrio (acrilico translucido).
 *
 * Sustituye a la barra pegada al borde por una capsula flotante al estilo de
 * las interfaces modernas de iPhone. El contenido pasa por debajo, y eso es lo
 * que crea el efecto: en iOS y web con desenfoque real (BlurView), y en
 * Android con una superficie casi opaca con borde y sombra que se lee igual
 * de "vidrio" SIN pagar el coste del blur — el desenfoque en Android redibuja
 * la textura en cada fotograma de scroll y eso son FPS que este proyecto ya
 * no esta dispuesto a perder (rendimiento > adorno).
 *
 * Solo pinta las pestañas visibles del grupo (tabs); las rutas con
 * `href: null` del layout (perfil ajeno, circulos, audio...) siguen viviendo
 * dentro del navegador pero no aparecen aqui, igual que antes.
 */

/** Pestañas visibles, en su orden. Igual que las Tabs.Screen del layout. */
const VISIBLE_TABS: Record<string, { icon: keyof typeof Feather.glyphMap }> = {
  home: { icon: 'home' },
  explore: { icon: 'search' },
  create: { icon: 'plus-square' },
  messages: { icon: 'message-square' },
  'profile/index': { icon: 'user' },
};

const BAR_HEIGHT = 62;

/** Capsula animada tras el icono activo. */
function ActivePill({ focused, color }: { focused: boolean; color: string }) {
  const progreso = useRef(new Animated.Value(focused ? 1 : 0)).current;
  useEffect(() => {
    // 180 ms: dentro del rango 150-250 que se percibe como respuesta, no como
    // animacion. Native driver: no toca el hilo de JavaScript.
    Animated.timing(progreso, {
      toValue: focused ? 1 : 0,
      duration: motion.fast,
      useNativeDriver: true,
    }).start();
  }, [focused, progreso]);

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.pill,
        {
          backgroundColor: color,
          opacity: progreso,
          transform: [
            { scale: progreso.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }) },
          ],
        },
      ]}
    />
  );
}

export function FloatingGlassTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const { colors, mode } = useAppTheme();

  /*
    Mensajes sin leer para el globo de la pestaña. Se leen del estado global
    con un selector primitivo: la barra solo se redibuja si el NUMERO cambia.
  */
  const unread = useAppStore((s) =>
    s.conversations.reduce((total, c) => total + (c.unread ?? 0), 0),
  );

  const rutas = state.routes.filter((route) => VISIBLE_TABS[route.name]);

  /*
    El desenfoque real solo donde no cuesta rendimiento. En Android el respaldo
    es una superficie translucida fuerte: mismo lenguaje visual, cero coste.
  */
  const conBlur = Platform.OS !== 'android';

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.host,
        {
          // Respeta el gesto/home indicator: la capsula flota POR ENCIMA de la
          // zona segura, nunca debajo de ella.
          bottom: Math.max(insets.bottom, spacing.sm) + spacing.sm,
        },
      ]}
    >
      {/* La sombra vive en el envoltorio: iOS ignora sombras cuando el mismo
          nodo recorta con overflow hidden (que el blur necesita). */}
      <View
        style={[
          styles.shadowWrap,
          {
            shadowColor: colors.glassShadow,
            ...(Platform.OS === 'android' ? { elevation: 10 } : null),
          },
        ]}
      >
        <View
          style={[
            styles.bar,
            {
              borderColor: colors.glassBorder,
              backgroundColor: conBlur ? colors.glassSurface : colors.glassSurfaceStrong,
            },
          ]}
        >
          {conBlur ? (
            <BlurView
              intensity={28}
              tint={mode === 'dark' ? 'dark' : 'light'}
              style={StyleSheet.absoluteFill}
            />
          ) : null}

          {rutas.map((route) => {
            const focused = state.routes[state.index]?.key === route.key;
            const opciones = descriptors[route.key]?.options;
            const etiqueta =
              typeof opciones?.title === 'string' ? opciones.title : route.name;
            const icono = VISIBLE_TABS[route.name]!.icon;
            const color = focused ? colors.primary : colors.textMuted;
            const globo = route.name === 'messages' && unread > 0;

            const onPress = () => {
              const evento = navigation.emit({
                type: 'tabPress',
                target: route.key,
                canPreventDefault: true,
              });
              if (!focused && !evento.defaultPrevented) {
                navigation.navigate(route.name, route.params);
              }
            };

            return (
              <Pressable
                key={route.key}
                onPress={onPress}
                style={styles.item}
                accessibilityRole="tab"
                accessibilityState={{ selected: focused }}
                accessibilityLabel={etiqueta}
              >
                <ActivePill focused={focused} color={colors.glassActive} />
                <View>
                  <Feather name={icono} size={22} color={color} />
                  {globo ? (
                    <View style={[styles.badge, { backgroundColor: colors.primary, borderColor: colors.surface }]}>
                      <Text style={[styles.badgeText, { color: colors.onPrimary }]}>
                        {unread > 99 ? '99+' : unread}
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Text numberOfLines={1} style={[styles.label, { color }]}>
                  {etiqueta}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  shadowWrap: {
    borderRadius: radius.pill,
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    height: BAR_HEIGHT,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.sm,
    overflow: 'hidden',
  },
  item: {
    minWidth: 60,
    height: BAR_HEIGHT - spacing.sm * 2,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
  },
  pill: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: radius.pill,
  },
  label: {
    fontSize: 10,
    fontFamily: getFontFamily('700'),
    fontWeight: Platform.OS === 'ios' ? '700' : undefined,
  },
  badge: {
    position: 'absolute',
    top: -5,
    right: -9,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: { fontSize: 9, fontWeight: '800' },
});
