import React, { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { ShortVideoItem } from '@/components/ShortVideoItem';
import { shorts } from '@/data/mockData';
import { palette, spacing } from '@/theme/tokens';
import type { Short } from '@/types';

const media = palette('dark');

export function ReelsScreen() {
  const router = useRouter();
  const { height } = useWindowDimensions();
  const [activeIndex, setActiveIndex] = useState(0);

  // Solo el item visible reproduce; el resto se pausa (memoria y batería).
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 80 }).current;
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: Array<{ index: number | null }> }) => {
      const first = viewableItems[0];
      if (first && typeof first.index === 'number') {
        setActiveIndex(first.index);
      }
    },
  ).current;

  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/home');
  }, [router]);

  return (
    <View style={styles.root}>
      <FlashList
        data={shorts}
        keyExtractor={(item: Short) => item.id}
        renderItem={({ item, index }: { item: Short; index: number }) => (
          <ShortVideoItem short={item} active={index === activeIndex} height={height} />
        )}
        pagingEnabled
        showsVerticalScrollIndicator={false}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
      />

      <Pressable
        onPress={close}
        style={[styles.backButton, { backgroundColor: media.overlay }]}
        accessibilityRole="button"
        accessibilityLabel="Volver"
      >
        <Feather name="arrow-left" size={24} color={media.text} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: media.background },
  backButton: {
    position: 'absolute',
    top: 50,
    left: spacing.lg,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },
});
