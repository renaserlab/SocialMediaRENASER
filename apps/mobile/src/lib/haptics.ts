import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

// Haptics ligeros para acciones clave (like, seguir, comprar). No-op en web y
// silencioso ante cualquier error (dispositivos sin motor háptico).
export const haptics = {
  light() {
    if (Platform.OS === 'web') return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  },
  medium() {
    if (Platform.OS === 'web') return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
  },
  success() {
    if (Platform.OS === 'web') return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  },
};
