import type { ViewStyle } from 'react-native';

import { conAlfa } from '@/lib/contrasteDeColor';
import { estilo, type AppPalette, type Categoria } from '@/theme/tokens';

/**
 * Cómo se pinta una pieza según las VARIANTES de estilo (`estilo` en tokens).
 *
 * Todas las funciones devuelven SOLO lo que cambia. Con la variante en
 * «actual» devuelven un objeto vacío o `undefined`, y el componente pinta
 * exactamente lo de hoy: por eso se combinan como `[estiloDeHoy, extra]` y
 * `extra.icono ?? colorDeHoy`.
 *
 * El color nunca va solo: lo que está activo/nuevo sigue diciéndolo con su
 * relleno, su negrita o su punto, como hasta ahora.
 */

export type AspectoDeCategoria = {
  /** Fondo/borde de la tarjeta que contiene el acceso. */
  tarjeta?: ViewStyle;
  /** Fondo/borde del círculo del icono. */
  circulo?: ViewStyle;
  /** Color del icono. */
  icono?: string;
  /** Color del rótulo (solo cuando el fondo es el color de la categoría). */
  texto?: string;
};

/**
 * Una pieza de categoría: acceso de Explorar, círculo de sección del perfil,
 * icono de un aviso… `activo` es su estado encendido (sección elegida, aviso
 * sin leer): en cualquier variante con color, va relleno del color.
 */
export function aspectoDeCategoria(
  colors: AppPalette,
  categoria: Categoria | null | undefined,
  { activo = false }: { activo?: boolean } = {},
): AspectoDeCategoria {
  const variante = estilo.estiloCategorias;
  if (variante === 'actual' || !categoria) return {};
  const c = colors.categorias[categoria];
  const lleno: AspectoDeCategoria = {
    circulo: { backgroundColor: c.color, borderColor: c.color },
    icono: c.sobre,
  };
  switch (variante) {
    case 'icono':
      return activo ? lleno : { icono: c.color };
    case 'tinte':
      return activo ? lleno : { circulo: { backgroundColor: c.suave, borderColor: c.suave }, icono: c.color };
    case 'tarjetaTinte':
      return {
        tarjeta: { backgroundColor: c.suave, borderColor: c.suave },
        ...(activo
          ? lleno
          : { circulo: { backgroundColor: colors.surface, borderColor: colors.surface }, icono: c.color }),
      };
    case 'solido':
      return {
        tarjeta: { backgroundColor: c.color, borderColor: c.color },
        circulo: activo
          ? { backgroundColor: c.color, borderColor: colors.text }
          : { backgroundColor: conAlfa(c.sobre, 0.2), borderColor: c.color },
        icono: c.sobre,
        texto: c.sobre,
      };
    default:
      return {};
  }
}

/**
 * Círculo de sección / icono de aviso: en `solido` el círculo va lleno del
 * color (no translúcido), porque no está dentro de una tarjeta de color.
 */
export function aspectoDeCirculoSuelto(
  colors: AppPalette,
  categoria: Categoria | null | undefined,
  opciones: { activo?: boolean } = {},
): AspectoDeCategoria {
  const a = aspectoDeCategoria(colors, categoria, opciones);
  if (estilo.estiloCategorias === 'solido' && categoria && !opciones.activo) {
    const c = colors.categorias[categoria];
    return { ...a, circulo: { backgroundColor: c.color, borderColor: c.color }, texto: undefined };
  }
  if (estilo.estiloCategorias === 'solido') return { ...a, texto: undefined };
  return a;
}

/** El acabado de una tarjeta genérica (`estiloTarjetas`, `radioTarjetas`). */
export function aspectoDeTarjeta(colors: AppPalette): ViewStyle | undefined {
  const radio = estilo.radioTarjetas === null ? undefined : { borderRadius: estilo.radioTarjetas };
  switch (estilo.estiloTarjetas) {
    case 'relleno':
      return { backgroundColor: colors.tarjetaRelleno, borderColor: 'transparent', ...radio };
    case 'sombra':
      return {
        borderColor: 'transparent',
        shadowColor: colors.glassShadow,
        shadowOpacity: 0.1,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 4 },
        elevation: 3,
        ...radio,
      };
    default:
      return radio;
  }
}

/** Icono → categoría, para los avisos (el aviso no guarda su tipo, sí su icono). */
export function categoriaDeIcono(icono: string): Categoria | null {
  switch (icono) {
    case 'bell':
      return 'comunidad';
    case 'message-square':
      return 'mensajes';
    case 'at-sign':
      return 'publicaciones';
    case 'award':
      return 'escuela';
    case 'calendar':
    case 'radio':
      return 'eventos';
    case 'image':
      return 'publicaciones';
    default:
      return null;
  }
}
