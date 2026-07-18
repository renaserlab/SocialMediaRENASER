import React from 'react';
import { Text as RNText, TextProps as RNTextProps, StyleSheet, Platform } from 'react-native';

import { getTextStyle } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export type TextVariant = 'display' | 'title' | 'titleMedium' | 'body' | 'secondary' | 'caption';

export interface TextProps extends RNTextProps {
  variant?: TextVariant;
  weight?: '400' | '500' | '600' | '700' | '800' | '900';
  color?: string;
}

export function Text({ variant = 'body', weight, color, style, ...props }: TextProps) {
  const { colors } = useAppTheme();

  // Resolve default weights if not explicitly passed
  let resolvedWeight = weight;
  if (!resolvedWeight) {
    if (variant === 'display' || variant === 'title' || variant === 'titleMedium') {
      resolvedWeight = '800';
    } else {
      resolvedWeight = '400';
    }
  }

  const baseStyle = styles[variant];
  const fontStyle = getTextStyle(resolvedWeight);

  return (
    <RNText
      style={[
        baseStyle,
        fontStyle,
        { color: color || colors.text },
        style,
      ]}
      {...props}
    />
  );
}

const styles = StyleSheet.create({
  display: {
    fontSize: 30,
    lineHeight: 34.5,
  },
  title: {
    fontSize: 24,
    lineHeight: 28,
  },
  titleMedium: {
    fontSize: 20,
    lineHeight: 24,
  },
  body: {
    fontSize: 14,
    lineHeight: 21.7,
  },
  secondary: {
    fontSize: 13,
    lineHeight: 18.2,
  },
  caption: {
    fontSize: 11,
    lineHeight: 15,
  },
});
