/**
 * Stickers del chat.
 *
 * QUÉ SON AQUÍ. Un sticker es un emoji mandado solo, que se pinta GRANDE y sin
 * burbuja. No son ilustraciones propias: Z no tiene todavía un paquete de
 * dibujos con licencia, y sin eso lo honesto es usar lo que ya trae cada
 * teléfono. El día que haya ilustraciones, se añaden como otro paquete.
 *
 * POR QUÉ NO HACE FALTA NADA EN EL SERVIDOR. Un sticker viaja como un mensaje
 * de texto cuyo texto es el emoji. Lo que cambia es cómo se pinta, y eso lo
 * decide `esSticker` mirando el texto: vale igual para el que se elige en el
 * panel que para el que alguien escribe con su teclado.
 *
 * SIN EXPRESIONES `\p{…}`. Las propiedades Unicode que harían esto en una
 * línea (`\p{Extended_Pictographic}`) no están garantizadas en el motor de
 * JavaScript de los teléfonos, y una expresión que no compila tumba la
 * pantalla entera. Se mira por rangos de códigos.
 *
 * Sin importaciones, a propósito: se prueba con `node --test` tal cual.
 */

export type PaqueteDeStickers = {
  clave: 'caras' | 'gestos' | 'celebrar' | 'estudio';
  /** El emoji que representa al paquete en su pestaña. */
  icono: string;
  stickers: readonly string[];
};

export const PAQUETES_DE_STICKERS: readonly PaqueteDeStickers[] = [
  {
    clave: 'caras',
    icono: '😀',
    stickers: ['😀', '😂', '🥹', '😍', '😎', '🤔', '😴', '😭', '😡', '🥳', '🤯', '🙄'],
  },
  {
    clave: 'gestos',
    icono: '👍',
    stickers: ['👍', '👎', '👏', '🙏', '🙌', '💪', '🤝', '👀', '👋', '🤞', '✌️', '🫶'],
  },
  {
    clave: 'celebrar',
    icono: '🎉',
    stickers: ['🎉', '🎂', '🏆', '🔥', '✨', '❤️', '💯', '🚀', '🌟', '🎁', '🥇', '🍾'],
  },
  {
    clave: 'estudio',
    icono: '📚',
    stickers: ['📚', '✏️', '💡', '✅', '❌', '⏰', '📌', '📝', '🎯', '🧠', '☕', '📎'],
  },
];

/** Las reacciones rápidas que se ofrecen sin abrir el panel. */
export const REACCIONES_RAPIDAS: readonly string[] = ['❤️', '👍', '😂', '😮', '😢', '🙏'];

/** Cuántos emoji seguidos se pintan todavía como sticker. Con más, es texto. */
export const MAX_EMOJI_DE_STICKER = 3;

const UNION = 0x200d; // une varios emoji en uno (una familia, una profesión)
const VARIANTE = 0xfe0f; // «píntalo como emoji y no como símbolo»
const TECLA = 0x20e3;

const esTonoDePiel = (c: number): boolean => c >= 0x1f3fb && c <= 0x1f3ff;
const esBandera = (c: number): boolean => c >= 0x1f1e6 && c <= 0x1f1ff;

/** Si un código es la base de un emoji (no un modificador). */
function esEmoji(c: number): boolean {
  return (
    (c >= 0x1f000 && c <= 0x1faff) || // caras, gestos, objetos, símbolos
    (c >= 0x2600 && c <= 0x27bf) || // ☀ ✅ ✏ ❤ …
    (c >= 0x2b00 && c <= 0x2bff) || // ⭐ ⬆ …
    (c >= 0x2300 && c <= 0x23ff) || // ⏰ ⌛ …
    c === 0x2615 || // ☕
    c === 0x203c ||
    c === 0x2049 ||
    c === 0x3030 ||
    c === 0x303d
  );
}

/**
 * Cuántos emoji tiene un texto que SOLO tiene emoji; `0` si tiene otra cosa.
 *
 * Los unidos (👨‍👩‍👧), con tono de piel (👍🏽) o con variante (❤️) cuentan como
 * uno. Una bandera son dos códigos y cuenta como una.
 */
export function contarEmoji(texto: string | null | undefined): number {
  const limpio = (texto ?? '').trim();
  if (!limpio) return 0;
  let cuenta = 0;
  let unido = false; // el anterior fue una unión: este pertenece al mismo emoji
  let media = false; // hay media bandera esperando su pareja
  for (const letra of limpio) {
    const c = letra.codePointAt(0) ?? 0;
    if (c === VARIANTE || c === TECLA || esTonoDePiel(c)) continue;
    if (c === UNION) {
      unido = true;
      continue;
    }
    if (/\s/.test(letra)) {
      unido = false;
      continue;
    }
    if (!esEmoji(c)) return 0;
    if (esBandera(c)) {
      if (media) {
        media = false;
      } else {
        media = true;
        cuenta += 1;
      }
      continue;
    }
    if (!unido) cuenta += 1;
    unido = false;
  }
  return cuenta;
}

/**
 * Si un mensaje se pinta como sticker: solo emoji, y pocos.
 *
 * Un mensaje con adjuntos nunca lo es, y eso lo decide quien llama: aquí solo
 * se mira el texto.
 */
export function esSticker(texto: string | null | undefined): boolean {
  const cuantos = contarEmoji(texto);
  return cuantos >= 1 && cuantos <= MAX_EMOJI_DE_STICKER;
}
