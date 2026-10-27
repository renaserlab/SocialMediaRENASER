/**
 * Renaser Social Media — Design Tokens
 * Fuente de verdad del sistema visual: blanco, negro y grises, con color
 * solo en los RESALTES (ver más abajo), como Instagram o TikTok.
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
   Blanco, negro y escala de grises. El color va en RESALTES.
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

/* =========================================================
   RESALTES — el único sitio donde entra color.

   La base sigue en blanco, negro y grises. El color se reserva
   para lo que «se enciende», como en TikTok: el anillo de una
   historia nueva, el globo de no leídos, «EN VIVO», el corazón,
   el «+» de crear y el botón principal (Seguir, Reservar, enviar).
   Un solo rosa —más oscuro en claro para que la letra blanca
   encima pase de 4,5:1— y el degradado cian → violeta → rosa del
   anillo. Elegido el 27/10/2026 entre seis niveles de color sobre
   capturas de la app real (el «N4»).

   El color nunca es lo único que informa: cada elemento ya lleva
   forma, texto o icono (corazón relleno, cifra del globo, «EN VIVO»,
   subrayado del enlace, negrita de la etiqueta, rótulo de la pestaña).
   `resaltes.test.mts` mide los contrastes.
   ========================================================= */

/** Un color, o varios para un degradado (solo `anillo`). */
export type ColorODegradado = string | readonly string[];

/** Las categorías de contenido (accesos de Explorar, círculos del perfil, avisos…). */
export const CATEGORIAS = [
  'escuela',
  'eventos',
  'servicios',
  'productos',
  'podcast',
  'comunidad',
  'publicaciones',
  'resenas',
  'mensajes',
] as const;
export type Categoria = (typeof CATEGORIAS)[number];

/** `color`: icono/relleno. `suave`: tinte de fondo. `sobre`: tinta encima de `color`. */
export type ColorDeCategoria = { color: string; suave: string; sobre: string };

type Resaltes = {
  /** Botón principal (`Button` primary): Seguir, Reservar, Publicar… y el de enviar del chat. */
  accion: string;
  /** Texto e icono sobre `accion`. */
  sobreAccion: string;
  /** Corazón ENCENDIDO: publicación, comentario y reel. */
  meGusta: string;
  /** Marcador ENCENDIDO (guardar publicación). */
  guardado: string;
  /** Flechas ENCENDIDAS (republicar). */
  republicado: string;
  /** Globo y punto de no leídos (barra, bandeja, avisos, «ir al final» del chat). */
  aviso: string;
  /** Cifra sobre `aviso`. */
  sobreAviso: string;
  /** Anillo de historia SIN VER. Admite una lista de colores: degradado. */
  anillo: ColorODegradado;
  /** Enlaces (URL) escritos en un mensaje sobre el fondo del tema. Van subrayados. */
  enlace: string;
  /** #etiquetas y @menciones del texto de una publicación. Van en negrita. */
  mencion: string;
  /** Píldora «EN VIVO». Va siempre sobre vídeo: se lee de la paleta OSCURA. */
  envivo: string;
  /** Texto y punto sobre `envivo`. También se lee de la paleta OSCURA. */
  sobreEnvivo: string;
  /** Relleno de `BarraDeProgreso` (cursos, evaluación). */
  progreso: string;
  /** Icono y rótulo de la pestaña activa de la barra flotante. */
  pestanaActiva: string;
  /** Cápsula detrás de la pestaña activa. */
  pildoraActiva: string;
  /** Fondo de la burbuja PROPIA del chat (también en temas). */
  burbujaPropia: string;
  /** Texto, hora y marcas dentro de la burbuja propia. */
  sobreBurbujaPropia: string;
  /** Acento de detalle: subrayado del segmentado, chips, títulos de sección. */
  acento: string;
  /** Tinta sobre `acento`. */
  sobreAcento: string;
  /** Tinte suave del acento. */
  acentoSuave: string;
  /** Fondo de las tarjetas (`aspectoDeTarjeta`): gris, sin borde. */
  tarjetaRelleno: string;
  /** Colores por categoría. Hoy todas en gris: el tipo lo dice el icono y el rótulo. */
  categorias: Record<Categoria, ColorDeCategoria>;
  /*
    OPCIONALES: elementos que NO salen de `primary`. Sin valor, cada uno
    conserva su color neutro (el componente lleva el respaldo).
  */
  /** `+` de «Tu historia», `+` del compositor y pestaña «Crear». */
  crear?: string;
  /** Tinta sobre `crear` (el `+` de las insignias). */
  sobreCrear?: string;
  /** Lápiz de editar perfil. */
  editarPerfil?: string;
  sobreEditarPerfil?: string;
  /** Aro del aviso «X está en directo». Paleta OSCURA. */
  aroEnvivo?: string;
  /** Corazón grande del doble toque (sobre la foto). Paleta OSCURA. */
  corazonDobleToque?: string;
  /** Botón de enviar APAGADO: gris, para que no parezca listo con el rosa lavado. */
  enviarApagado?: string;
  sobreEnviarApagado?: string;
};

const todasLasCategorias = (c: ColorDeCategoria) =>
  Object.fromEntries(CATEGORIAS.map((nombre) => [nombre, c])) as Record<Categoria, ColorDeCategoria>;

const resaltesClaros: Resaltes = {
  accion: '#CF1155',
  sobreAccion: '#FFFFFF',
  meGusta: '#CF1155',
  guardado: light.primary,
  republicado: light.primary,
  aviso: '#CF1155',
  sobreAviso: '#FFFFFF',
  anillo: ['#0096BC', '#0096BC', '#7442E8', '#CF1155', '#CF1155'],
  enlace: light.text,
  mencion: light.text,
  envivo: '#E3165A',
  sobreEnvivo: '#FFFFFF',
  progreso: light.text,
  pestanaActiva: light.primary,
  pildoraActiva: light.glassActive,
  burbujaPropia: light.primary,
  sobreBurbujaPropia: light.onPrimary,
  acento: light.text,
  sobreAcento: '#FFFFFF',
  acentoSuave: 'rgba(0,0,0,0.08)',
  tarjetaRelleno: '#F3F3F3',
  categorias: todasLasCategorias({ color: light.text, suave: '#E6E6E6', sobre: '#FFFFFF' }),
  crear: '#CF1155',
  sobreCrear: '#FFFFFF',
  editarPerfil: '#CF1155',
  sobreEditarPerfil: '#FFFFFF',
  aroEnvivo: '#E3165A',
  corazonDobleToque: '#FF4785',
  enviarApagado: light.disabled,
  sobreEnviarApagado: '#000000',
};

const resaltesOscuros: Resaltes = {
  accion: '#E3165A',
  sobreAccion: '#FFFFFF',
  meGusta: '#FF4785',
  guardado: dark.primary,
  republicado: dark.primary,
  aviso: '#E3165A',
  sobreAviso: '#FFFFFF',
  anillo: ['#3EE0F2', '#3EE0F2', '#9B6BFF', '#FF4785', '#FF4785'],
  enlace: dark.text,
  mencion: dark.text,
  envivo: '#E3165A',
  sobreEnvivo: '#FFFFFF',
  progreso: dark.text,
  pestanaActiva: dark.primary,
  pildoraActiva: dark.glassActive,
  burbujaPropia: dark.primary,
  sobreBurbujaPropia: dark.onPrimary,
  acento: dark.text,
  sobreAcento: '#000000',
  acentoSuave: 'rgba(255,255,255,0.14)',
  tarjetaRelleno: '#161616',
  categorias: todasLasCategorias({ color: dark.text, suave: '#2A2A2A', sobre: '#000000' }),
  crear: '#FF4785',
  sobreCrear: '#FFFFFF',
  editarPerfil: '#E3165A',
  sobreEditarPerfil: '#FFFFFF',
  aroEnvivo: '#E3165A',
  corazonDobleToque: '#FF4785',
  enviarApagado: dark.disabled,
  sobreEnviarApagado: '#FFFFFF',
};

const claro = { ...light, ...resaltesClaros };
const oscuro = { ...dark, ...resaltesOscuros };

export const palette = (mode: ThemeMode) => (mode === 'dark' ? oscuro : claro);
export type AppPalette = ReturnType<typeof palette>;

/* =========================================================
   ACABADO. Las piezas comunes leen de aquí su variante, así que
   el acabado se ajusta en un solo sitio (ver `aspecto.ts`).
   La elegida: categorías en círculo gris, tarjetas grises sin
   borde y radio 16, «Para ti» subrayado, botones en píldora y
   anillo de historias de 3 px. «actual» es el aspecto anterior
   al 27/10/2026.
   ========================================================= */
export const OPCIONES_DE_ESTILO = {
  /** Cómo se distinguen las categorías (accesos, círculos, avisos…). */
  estiloCategorias: ['actual', 'icono', 'tinte', 'tarjetaTinte', 'solido'],
  /** Acabado de las tarjetas: borde de 1 px, relleno suave o sombra. */
  estiloTarjetas: ['actual', 'relleno', 'sombra'],
  /** Segmentado «Para ti / Siguiendo» y similares. */
  segmentado: ['actual', 'acento', 'subrayado', 'pildoraSuave'],
  /** Chips de filtro seleccionados. */
  chips: ['actual', 'acento', 'pildoraSuave', 'contorno'],
  /** Títulos de sección y «Ver más/Ver todo». */
  titulosDeSeccion: ['actual', 'conAcento'],
  /** Forma de los botones (`Button`). */
  estiloBotones: ['actual', 'pildora'],
} as const;

type Opciones = typeof OPCIONES_DE_ESTILO;
export type Estilo = { [K in keyof Opciones]: Opciones[K][number] } & {
  /** Grosor del anillo de historias en px (1–4). `null`: el de antes (2). */
  grosorAnillo: number | null;
  /** Radio de las tarjetas en px (0–32). `null`: el propio de cada tarjeta. */
  radioTarjetas: number | null;
};

export const estilo: Estilo = {
  estiloCategorias: 'tinte',
  estiloTarjetas: 'relleno',
  segmentado: 'subrayado',
  chips: 'acento',
  titulosDeSeccion: 'conAcento',
  estiloBotones: 'pildora',
  grosorAnillo: 3,
  radioTarjetas: 16,
};

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