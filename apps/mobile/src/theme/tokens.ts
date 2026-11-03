/**
 * Renaser Social Media — Design Tokens
 * Fuente de verdad del sistema visual: blanco, negro y grises, con color
 * solo en los RESALTES (ver más abajo): esmeralda y oro.
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
   para lo que «se enciende»: el anillo de una historia nueva, el
   globo de no leídos, «EN VIVO», el corazón y el «+» de crear.

   ESMERALDA Y ORO (30/10/2026). Sustituyen al rosa del «N4» del
   27/10 (rosa con anillo cian → violeta → rosa) porque se parecía
   demasiado a TikTok. Aprobados sobre un lienzo de la app real:
   - esmeralda #0B5A50 para globos, «EN VIVO», corazón y «+»;
   - anillo de esmeralda profundo #01302C → esmeralda → oro
     #C9A24E → oro claro #EBD58F (45°, paradas al 0/35/72/100 %).
   Los botones (Seguir, Mensaje, Reservar, enviar) y el lápiz de
   editar perfil vuelven a ser NEGROS, como antes del 27/10: con
   color competían con los resaltes y ya se reconocen por la forma.

   El modo oscuro no se maquetó. El #0B5A50 se pierde sobre negro
   (2,6:1), así que sube de luz SIN cambiar de tono: #0F7B6C donde
   lleva letra blanca encima (globo, «EN VIVO»: 5,2:1, y 4,1:1 sobre
   negro) y #149F8C para el corazón y el «+» (6,4:1 sobre negro; el
   «+» blanco encima, 3,3:1). El oro ya brilla sobre negro y cierra
   el anillo igual que en claro.

   El color nunca es lo único que informa: cada elemento ya lleva
   forma, texto o icono (corazón relleno, cifra del globo, «EN VIVO»,
   subrayado del enlace, negrita de la etiqueta, rótulo de la pestaña).
   `resaltes.test.mts` mide los contrastes. El oro del anillo no
   llega a 3:1 sobre blanco —es lo que lo hace luminoso—, así que
   allí se exige que el aro destaque en al menos media vuelta (en
   claro, el 65 %) y que su arranque, el color sólido de respaldo,
   también lo haga.
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
  /**
   * Botón principal (`Button` primary): Seguir, Reservar, Publicar… y el de enviar del chat.
   * Neutro desde el 30/10/2026 (la acción base: negro en claro, blanco en oscuro).
   */
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
  /** Lápiz de editar perfil. Neutro desde el 30/10/2026: el mismo respaldo del componente. */
  editarPerfil?: string;
  sobreEditarPerfil?: string;
  /** Aro del aviso «X está en directo». Paleta OSCURA. */
  aroEnvivo?: string;
  /** Corazón grande del doble toque (sobre la foto). Paleta OSCURA. */
  corazonDobleToque?: string;
  /**
   * Botón de enviar APAGADO: gris opaco. Si `accion` lleva color, el botón al
   * 35 % sale de un tono lavado que parece otro estado en vez de «apagado».
   */
  enviarApagado?: string;
  sobreEnviarApagado?: string;
};

const todasLasCategorias = (c: ColorDeCategoria) =>
  Object.fromEntries(CATEGORIAS.map((nombre) => [nombre, c])) as Record<Categoria, ColorDeCategoria>;

const resaltesClaros: Resaltes = {
  // Botones en negro: la acción base, la misma que antes del 27/10.
  accion: light.primary,
  sobreAccion: light.onPrimary,
  meGusta: '#0B5A50',
  guardado: light.primary,
  republicado: light.primary,
  aviso: '#0B5A50',
  sobreAviso: '#FFFFFF',
  /*
    El degradado del lienzo MUESTREADO en 12 puntos. `LinearGradient` reparte
    los colores a partes iguales (StoriesRow no le pasa `locations`), así que
    los cuatro del lienzo caen en el 0, 36, 73 y 100 % —casi su 0/35/72/100— y
    los de en medio son su mezcla lineal, la misma que pintaría el degradado.
    El 45° ya lo da StoriesRow (de abajo-izquierda a arriba-derecha).
  */
  anillo: ['#01302C', '#043B35', '#06453E', '#095047', '#0B5A50', '#3A6C50', '#6A7E4F', '#99904F', '#C9A24E', '#D4B364', '#E0C479', '#EBD58F'],
  enlace: light.text,
  mencion: light.text,
  // `envivo`, `aroEnvivo` y `corazonDobleToque` se leen de la paleta OSCURA
  // (van sobre foto o vídeo); aquí llevan el esmeralda del lienzo por coherencia.
  envivo: '#0B5A50',
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
  crear: '#0B5A50',
  sobreCrear: '#FFFFFF',
  // El lápiz, negro con el icono del color del fondo: el respaldo de ProfileScreen.
  editarPerfil: light.text,
  sobreEditarPerfil: light.background,
  aroEnvivo: '#0B5A50',
  corazonDobleToque: '#0B5A50',
  enviarApagado: light.disabled,
  sobreEnviarApagado: '#000000',
};

const resaltesOscuros: Resaltes = {
  // Botones en blanco con letra negra: la acción base del modo oscuro. Es
  // también el «Seguir» que va sobre el vídeo del directo.
  accion: dark.primary,
  sobreAccion: dark.onPrimary,
  meGusta: '#149F8C',
  guardado: dark.primary,
  republicado: dark.primary,
  aviso: '#0F7B6C',
  sobreAviso: '#FFFFFF',
  /*
    Mismo muestreo que en claro, con el tramo esmeralda subido de luz
    (#0F7B6C → #149F8C): el esmeralda profundo del lienzo no se ve sobre negro.
    Todo el aro pasa de 4:1 sobre el fondo.
  */
  anillo: ['#0F7B6C', '#108474', '#128D7C', '#139684', '#149F8C', '#41A07D', '#6EA16D', '#9CA15E', '#C9A24E', '#D4B364', '#E0C479', '#EBD58F'],
  enlace: dark.text,
  mencion: dark.text,
  envivo: '#0F7B6C',
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
  crear: '#149F8C',
  sobreCrear: '#FFFFFF',
  editarPerfil: dark.text,
  sobreEditarPerfil: dark.background,
  aroEnvivo: '#0F7B6C',
  corazonDobleToque: '#149F8C',
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

/* =========================================================
   EL RÓTULO DEL DIRECTO (aprobado el 02/11/2026).

   El texto que quien emite pone encima de la imagen. Va SIEMPRE sobre
   vídeo, así que no cambia con el tema de la persona: igual que
   `sobreMedio`, se lee sobre oscuro.

   UNA PALETA CERRADA DE OCHO, no una rueda: con una rueda salen colores
   que no se leen encima de un vídeo. El servidor guarda el NOMBRE
   (`blanco`, `oro`…); qué tinta es cada uno se decide aquí.

   Cada color tiene tres tintas:
   - `texto`: la letra cuando va sin fondo o sobre velo. Clara para que
     se lea sobre oscuro (el esmeralda y el rojo suben de luz, como hace
     el modo oscuro con los resaltes).
   - `relleno`: el fondo «sólido».
   - `sobreRelleno`: la letra encima del sólido, 4,5 a 1 como mínimo
     (`rotuloDeDirecto.test.mts` lo mide).
   Esmeralda y oro son los de la marca (resaltes en oscuro y el oro del
   anillo). El negro va con velo CLARO detrás y sombra clara sin fondo:
   negro sobre negro no se leería.
   ========================================================= */
export const rotuloDeDirecto = {
  colores: {
    blanco: { texto: '#FFFFFF', relleno: '#FFFFFF', sobreRelleno: '#0A0A0A' },
    negro: { texto: '#0A0A0A', relleno: '#0A0A0A', sobreRelleno: '#FFFFFF' },
    esmeralda: { texto: '#149F8C', relleno: '#0F7B6C', sobreRelleno: '#FFFFFF' },
    oro: { texto: '#C9A24E', relleno: '#C9A24E', sobreRelleno: '#0A0A0A' },
    rojo: { texto: '#FF5A4F', relleno: '#C62828', sobreRelleno: '#FFFFFF' },
    azul: { texto: '#5B9BFF', relleno: '#1F5FD1', sobreRelleno: '#FFFFFF' },
    amarillo: { texto: '#FFD60A', relleno: '#FFD60A', sobreRelleno: '#0A0A0A' },
    rosa: { texto: '#FF6FAE', relleno: '#FF6FAE', sobreRelleno: '#0A0A0A' },
  },
  /** El velo de siempre detrás del texto, y su borde. */
  velo: 'rgba(0,0,0,0.78)',
  bordeDelVelo: 'rgba(255,255,255,0.14)',
  /** El velo detrás de la letra NEGRA: claro. */
  veloClaro: 'rgba(255,255,255,0.84)',
  bordeDelVeloClaro: 'rgba(0,0,0,0.12)',
  /** Borde fino del relleno sólido, para que se recorte sobre su mismo color. */
  bordeDelRelleno: 'rgba(255,255,255,0.14)',
  /** «Sin fondo»: una sombra detrás de cada letra. Clara si la letra es negra. */
  sombra: 'rgba(0,0,0,0.9)',
  sombraClara: 'rgba(255,255,255,0.95)',
  /** Las guías del imán al centro, mientras se arrastra. */
  guia: '#149F8C',
  /** La zona por donde se puede llevar, mientras se arrastra. */
  zonaBorde: 'rgba(255,255,255,0.38)',
  zonaRelleno: 'rgba(255,255,255,0.035)',
  zonaTexto: 'rgba(255,255,255,0.6)',
  /** El marco discontinuo que le dice al host que el texto se puede tocar. */
  marcoDelHost: 'rgba(255,255,255,0.55)',
  /** La papelera de arriba y su letrero. Encendida va en rojo de peligro. */
  papelera: 'rgba(0,0,0,0.62)',
  bordeDeLaPapelera: 'rgba(255,255,255,0.32)',
  letreroDeLaPapelera: 'rgba(0,0,0,0.7)',
  /** «Texto quitado · Deshacer». */
  avisoQuitado: 'rgba(17,17,17,0.95)',
  /**
   * El velo de la hoja de editar el texto. Más suave que el de las demás
   * hojas: el host tiene que ver detrás, al momento, lo que está cambiando.
   */
  veloDeLaHoja: 'rgba(0,0,0,0.3)',
} as const;

/* =========================================================
   LA HOJA DE EFECTOS DE CÁMARA (aprobada el 02/11/2026, maqueta v4).

   Va SIEMPRE sobre la cámara de quien emite: oscura y translúcida en los
   dos temas, como `sobreMedio`. El velo de detrás es TRANSPARENTE: quien
   ajusta la luz o el contraste tiene que ver su imagen tal cual sale, no
   oscurecida. En iOS y web el panel lleva desenfoque real detrás; Android
   no lo paga (como la barra flotante) y va algo más opaco.

   El único color es el esmeralda de la marca en la muesca del 50, cuando la
   barra está enganchada ahí: es la misma guía del imán que la del rótulo.
   ========================================================= */
export const efectosDeCamara = {
  velo: 'transparent',
  /** El panel con desenfoque detrás (iOS y web) y sin él (Android). */
  hoja: 'rgba(0,0,0,0.58)',
  hojaSinDesenfoque: 'rgba(0,0,0,0.74)',
  asa: 'rgba(255,255,255,0.4)',
  texto: '#FFFFFF',
  /** Los círculos de «Mejorar» y las miniaturas de los fondos. */
  circulo: 'rgba(255,255,255,0.14)',
  circuloElegido: 'rgba(255,255,255,0.22)',
  /** El anillo de lo elegido, y su separación oscura en las miniaturas. */
  anillo: '#FFFFFF',
  separacionDelAnillo: 'rgba(0,0,0,0.55)',
  /** El punto de un efecto encendido que no es el elegido. */
  punto: '#FFFFFF',
  bordeDelPunto: 'rgba(0,0,0,0.45)',
  /** La barra 0–100. */
  carril: 'rgba(255,255,255,0.3)',
  relleno: '#FFFFFF',
  muesca: 'rgba(255,255,255,0.45)',
  muescaEnganchada: rotuloDeDirecto.guia,
  pulgar: '#FFFFFF',
  sombra: '#000000',
  burbuja: '#FFFFFF',
  textoDeLaBurbuja: '#000000',
  /** «Mantén para ver sin efecto»: suelto y apretado. */
  ojo: 'rgba(0,0,0,0.42)',
  ojoApretado: '#FFFFFF',
  iconoDelOjoApretado: '#000000',
  /** «Así sales sin efecto», encima de la cámara mientras se mantiene el ojo. */
  insignia: 'rgba(0,0,0,0.72)',
  bordeDeLaInsignia: 'rgba(255,255,255,0.22)',
} as const;

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