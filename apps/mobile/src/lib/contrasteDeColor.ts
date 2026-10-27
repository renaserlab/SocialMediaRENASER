/**
 * Contraste entre colores (WCAG 2.x), sin dependencias.
 *
 * Existe para elegir un color POR CONTRASTE CON SU FONDO y no por el modo
 * claro/oscuro. Con la burbuja propia del chat en negro o en blanco daba
 * igual; con una burbuja de color (un tema), «leído» en celeste o un enlace en
 * azul podían quedar invisibles sobre ella.
 *
 * Entiende `#rgb`, `#rrggbb`, `#rrggbbaa` y `rgb()/rgba()`. Lo que no entiende
 * devuelve `null`, y quien llama decide qué hacer (normalmente, lo de antes).
 */

export type Rgb = { r: number; g: number; b: number; a: number };

export function leerColor(color: string | null | undefined): Rgb | null {
  const texto = (color ?? '').trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(texto)?.[1];
  if (hex) {
    const largo = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex;
    const canal = (i: number) => Number.parseInt(largo.slice(i, i + 2), 16);
    return { r: canal(0), g: canal(2), b: canal(4), a: largo.length === 8 ? canal(6) / 255 : 1 };
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(texto);
  if (rgb) {
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
      a: rgb[4] === undefined ? 1 : Number(rgb[4]),
    };
  }
  return null;
}

/** Luminancia relativa (0 negro, 1 blanco). `null` si el color no se entiende. */
export function luminancia(color: string | null | undefined): number | null {
  const c = leerColor(color);
  if (!c) return null;
  const lineal = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lineal(c.r) + 0.7152 * lineal(c.g) + 0.0722 * lineal(c.b);
}

/** Razón de contraste (1 a 21). `null` si alguno no se entiende. */
export function contraste(a: string | null | undefined, b: string | null | undefined): number | null {
  const la = luminancia(a);
  const lb = luminancia(b);
  if (la === null || lb === null) return null;
  const [clara, oscura] = la > lb ? [la, lb] : [lb, la];
  return (clara + 0.05) / (oscura + 0.05);
}

/**
 * De los candidatos, el que más contrasta con `fondo`. Con un fondo que no se
 * entiende devuelve `null`.
 */
export function elMasLegible(fondo: string, candidatos: readonly string[]): string | null {
  let mejor: string | null = null;
  let razon = -1;
  for (const candidato of candidatos) {
    const r = contraste(fondo, candidato);
    if (r !== null && r > razon) {
      mejor = candidato;
      razon = r;
    }
  }
  return mejor;
}

/** Blanco o negro, el que mejor se lea sobre `fondo`. */
export function tintaSobre(fondo: string): '#FFFFFF' | '#000000' {
  return elMasLegible(fondo, ['#FFFFFF', '#000000']) === '#000000' ? '#000000' : '#FFFFFF';
}

/** El mismo color con otra opacidad, como `rgba()`. Si no se entiende, tal cual. */
export function conAlfa(color: string, alfa: number): string {
  const c = leerColor(color);
  if (!c) return color;
  return `rgba(${c.r},${c.g},${c.b},${alfa})`;
}
