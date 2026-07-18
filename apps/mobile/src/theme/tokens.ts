import { ThemeMode } from '@/types';

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  xl: 28,
  pill: 999,
} as const;

const light = {
  background: '#F7F7F5',
  surface: '#FFFFFF',
  surfaceAlt: '#EFEFED',
  text: '#0A0A0A',
  textMuted: '#686868',
  border: '#DFDFDC',
  primary: '#000000',
  onPrimary: '#FFFFFF',
  success: '#176D3A',
  danger: '#A62424',
  overlay: 'rgba(0,0,0,0.55)',
};

const dark = {
  background: '#090909',
  surface: '#141414',
  surfaceAlt: '#202020',
  text: '#F6F6F6',
  textMuted: '#A9A9A9',
  border: '#303030',
  primary: '#FFFFFF',
  onPrimary: '#000000',
  success: '#65C98B',
  danger: '#FF8080',
  overlay: 'rgba(0,0,0,0.72)',
};

export const palette = (mode: ThemeMode) => (mode === 'dark' ? dark : light);
export type AppPalette = ReturnType<typeof palette>;
