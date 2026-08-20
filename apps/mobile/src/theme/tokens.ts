/**
 * Renaser Social Media — Design Tokens
 * Fuente de verdad del sistema visual (blanco y negro estricto).
 * Valores alineados al prompt maestro (§4 Dirección visual inalterable).
 *
 * Ubicación sugerida en tu monorepo:
 *   apps/mobile/src/theme/tokens.ts   (reemplaza el actual)
 *   packages/design-system/tokens.ts  (cuando centralices el DS)
 *
 * Regla de oro: NUNCA escribas un hex directo en un componente.
 * Consume siempre estos tokens semánticos.
 */

export type ThemeMode = 'light' | 'dark';

/* ---------- Escala de espaciado (4pt) ---------- */
export const spacing = {
  xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48,
} as const;

/* ---------- Radios ---------- */
export const radius = {
  sm: 8, md: 12, lg: 18, xl: 28, pill: 999,
} as const;

import { Platform } from 'react-native';

/* ---------- Tipografía (SF Pro en iOS, Inter en web/Android) ---------- */
export const typography = {
  family: {
    regular: Platform.OS === 'ios' ? 'System' : 'Inter_400Regular',
    medium: Platform.OS === 'ios' ? 'System' : 'Inter_500Medium',
    semibold: Platform.OS === 'ios' ? 'System' : 'Inter_600SemiBold',
    bold: Platform.OS === 'ios' ? 'System' : 'Inter_700Bold',
    extrabold: Platform.OS === 'ios' ? 'System' : 'Inter_800ExtraBold',
    black: Platform.OS === 'ios' ? 'System' : 'Inter_900Black',
  },
  size: { xs: 11, sm: 13, md: 14, lg: 16, xl: 20, xxl: 24, display: 30 },
  weight: { regular: '400', medium: '500', semibold: '600', bold: '700', black: '800' },
  lineHeight: { tight: 1.15, normal: 1.4, relaxed: 1.6 },
} as const;

export function getFontFamily(weight: '400' | '500' | '600' | '700' | '800' | '900') {
  if (Platform.OS === 'ios') return 'System';
  switch (weight) {
    case '400': return 'Inter_400Regular';
    case '500': return 'Inter_500Medium';
    case '600': return 'Inter_600SemiBold';
    case '700': return 'Inter_700Bold';
    case '800': return 'Inter_800ExtraBold';
    case '900': return 'Inter_900Black';
    default: return 'Inter_400Regular';
  }
}

export function getTextStyle(weight: '400' | '500' | '600' | '700' | '800' | '900' = '400') {
  return {
    fontFamily: getFontFamily(weight),
    fontWeight: Platform.OS === 'ios' ? weight : undefined,
  };
}

/* ---------- Motion (ms) ---------- */
export const motion = {
  fast: 180,     // feedback y navegación simple (150–220)
  medium: 300,   // sheets y transiciones de contexto (250–350)
  easing: 'ease-out',
} as const;

/* ---------- Breakpoints (para web / tablet) ---------- */
export const breakpoints = {
  mobile: 390, tablet: 768, laptop: 1280, desktop: 1440,
} as const;

/* =========================================================
   PALETA SEMÁNTICA — Light / Dark
   Blanco, negro y escala de grises. Sin colores decorativos.
   Los estados funcionales (error/success) mantienen accesibilidad,
   pero NUNCA deben depender solo del color: acompañar con
   icono, texto, borde o patrón.
   ========================================================= */
const light = {
  // superficies
  background: '#FFFFFF', // surface/base
  backgroundAlt: '#F7F7F7', // surface/secondary
  surface: '#FFFFFF', // surface/primary (cards, sheets)
  surfaceAlt: '#F7F7F7', // surface/muted
  // texto
  text: '#0A0A0A', // text/primary
  textMuted: '#6B6B6B', // text/secondary
  textInverse: '#FFFFFF', // text/inverse (sobre negro)
  // líneas y bordes
  border: '#EAEAEA', // border/subtle
  // acción
  primary: '#000000', // action/primary
  onPrimary: '#FFFFFF', // action/inverse (texto sobre botón)
  // estados
  disabled: '#BDBDBD', // state/disabled
  success: '#1B7A3D', // state/success (usar con icono/texto)
  danger: '#B3261E', // state/error   (usar con icono/texto)
  // overlays
  overlay: 'rgba(0,0,0,0.55)',
  /*
    Vidrio (barra flotante). `glassSurface` acompaña al blur real (iOS/web);
    `glassSurfaceStrong` es el respaldo SIN blur de Android: mas opaco para
    que el contenido de debajo no ensucie la lectura de los iconos.
  */
  glassSurface: 'rgba(255,255,255,0.70)',
  glassSurfaceStrong: 'rgba(250,250,250,0.94)',
  glassBorder: 'rgba(0,0,0,0.10)',
  glassActive: 'rgba(0,0,0,0.08)', // capsula del tab activo
  glassShadow: '#000000',
} as const;

const dark = {
  background: '#000000',
  backgroundAlt: '#0A0A0A',
  surface: '#111111',
  surfaceAlt: '#0A0A0A',
  text: '#FFFFFF',
  textMuted: '#A1A1A1',
  textInverse: '#000000',
  border: '#242424',
  primary: '#FFFFFF',
  onPrimary: '#000000',
  disabled: '#5A5A5A',
  success: '#5BD68A',
  danger: '#FF8A80',
  overlay: 'rgba(0,0,0,0.72)',
  glassSurface: 'rgba(20,20,20,0.70)',
  glassSurfaceStrong: 'rgba(18,18,18,0.94)',
  glassBorder: 'rgba(255,255,255,0.14)',
  glassActive: 'rgba(255,255,255,0.14)',
  glassShadow: '#000000',
} as const;

export const palette = (mode: ThemeMode) => (mode === 'dark' ? dark : light);
export type AppPalette = ReturnType<typeof palette>;

/* ---------- Alias semánticos (opcional, estilo Figma prompt) ---------- */
export const tokenNames = {
  'surface/primary': 'surface',
  'surface/secondary': 'backgroundAlt',
  'text/primary': 'text',
  'text/secondary': 'textMuted',
  'border/subtle': 'border',
  'action/primary': 'primary',
  'action/inverse': 'onPrimary',
  'state/error': 'danger',
  'state/success': 'success',
  'state/disabled': 'disabled',
} as const;