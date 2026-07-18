import { Image, StyleSheet, Text, View } from 'react-native';

import { assets } from '@/data/assets';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  size?: number;
  label?: string;
  image?: 'avatar' | 'speaker' | 'hero';
};

export function Avatar({ size = 44, label, image = 'avatar' }: Props) {
  const { colors } = useAppTheme();
  return (
    <View style={{ alignItems: 'center', gap: 5 }}>
      <Image source={assets[image]} style={{ width: size, height: size, borderRadius: size / 2 }} />
      {label ? <Text numberOfLines={1} style={[styles.label, { color: colors.text }]}>{label}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 10, maxWidth: 70, textAlign: 'center', fontWeight: '600' },
});
