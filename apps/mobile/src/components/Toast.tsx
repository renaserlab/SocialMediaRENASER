import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type ToastProps = {
  message: string;
  visible: boolean;
  onHide?: () => void;
  duration?: number;
  icon?: keyof typeof Feather.glyphMap;
};

export function Toast({ message, visible, onHide, duration = 3000, icon = 'info' }: ToastProps) {
  const { colors } = useAppTheme();
  const slideAnim = useRef(new Animated.Value(-100)).current;

  useEffect(() => {
    if (visible) {
      // Slide down
      Animated.spring(slideAnim, {
        toValue: 50, // Position from top
        useNativeDriver: true,
        tension: 50,
        friction: 8,
      }).start();

      const timer = setTimeout(() => {
        // Slide up
        Animated.timing(slideAnim, {
          toValue: -100,
          duration: 250,
          useNativeDriver: true,
        }).start(() => {
          onHide?.();
        });
      }, duration);

      return () => clearTimeout(timer);
    } else {
      slideAnim.setValue(-100);
    }
  }, [visible, slideAnim, duration, onHide]);

  if (!visible) return null;

  return (
    <Animated.View
      style={[
        styles.container,
        {
          transform: [{ translateY: slideAnim }],
          backgroundColor: colors.primary,
          borderColor: colors.border,
        },
      ]}
    >
      <View style={styles.content}>
        <Feather name={icon} size={18} color={colors.onPrimary} style={styles.icon} />
        <Text style={[styles.message, { color: colors.onPrimary }]}>{message}</Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: spacing.lg,
    right: spacing.lg,
    zIndex: 9999,
    borderRadius: radius.md,
    borderWidth: 1,
    padding: spacing.md,
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  icon: {
    marginRight: spacing.sm,
  },
  message: {
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
});
