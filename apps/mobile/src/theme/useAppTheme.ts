import { palette } from '@/theme/tokens';
import { useAppStore } from '@/store/useAppStore';

export function useAppTheme() {
  const mode = useAppStore((state) => state.themeMode);
  return { mode, colors: palette(mode) };
}
