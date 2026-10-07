/**
 * LOS ENLACES QUE HAY DENTRO DE UN TEXTO.
 *
 * Pedido el 07/10/2026: al pegar en un chat el enlace de una reunión (un Meet,
 * por ejemplo) salía como texto corrido y no se podía tocar; había que copiarlo
 * a mano. Tiene que verse como enlace y abrirse con un toque.
 *
 * Lógica pura: parte el texto en trozos —lo que es enlace y lo que no— y dice a
 * qué dirección lleva cada uno. Quien pinta solo recorre los trozos.
 *
 * QUÉ SE RECONOCE, de más seguro a menos:
 *
 *   · lo que empieza por `http://` o `https://`;
 *   · lo que empieza por `www.`;
 *   · un dominio suelto con una terminación conocida (`meet.google.com/abc`),
 *     que es como la gente lo escribe de memoria.
 *
 * QUÉ NO: lo que va pegado a una arroba. `nombre@gmail.com` es un correo, y
 * convertir `gmail.com` en enlace dentro de él lo rompe en dos.
 *
 * SOLO SE ABRE `http` Y `https`. Un texto no puede hacer que tocarlo lance una
 * llamada, un SMS o un esquema interno de otra aplicación: lo que no empieza
 * por uno de esos dos, o no trae esquema, se abre siempre como `https://`.
 */

export type TrozoDeTexto =
  | { tipo: 'texto'; texto: string }
  | { tipo: 'enlace'; texto: string; direccion: string };

/**
 * Terminaciones con las que se acepta un dominio escrito sin `http` ni `www`.
 *
 * POCAS, Y A PROPÓSITO. «me», «es», «co» o «ar» también son terminaciones, y
 * en un chat se escribe «ok.me avisas» o «listo.es tarde» sin espacio tras el
 * punto: con ellas, media conversación saldría subrayada. Quien quiera enlazar
 * otro dominio lo pega con su `https://`, que es como sale al copiarlo.
 */
const TERMINACIONES = 'com|org|net|pe|io|edu|gob|gov|app|dev';

const PATRON = new RegExp(
  '(' +
    'https?:\\/\\/[^\\s<>]+' +
    '|www\\.[^\\s<>]+' +
    `|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TERMINACIONES})(?![a-z0-9-])(?:[/?#][^\\s<>]*)?` +
    ')',
  'gi',
);

/** Lo que suele ir pegado detrás de un enlace sin ser parte de él. */
const PUNTUACION_FINAL = /[.,;:!?'"»)\]}]+$/;

/**
 * Quita del final la puntuación que no es del enlace.
 *
 * Un paréntesis de cierre se respeta si dentro del enlace hay uno de apertura
 * sin cerrar: las direcciones de Wikipedia terminan así.
 */
function sinPuntuacionFinal(candidato: string): string {
  let limpio = candidato;
  for (;;) {
    const cola = PUNTUACION_FINAL.exec(limpio)?.[0];
    if (!cola) return limpio;
    const ultimo = limpio[limpio.length - 1];
    if (ultimo === ')') {
      const abiertos = limpio.split('(').length - 1;
      const cerrados = limpio.split(')').length - 1;
      if (abiertos >= cerrados) return limpio;
    }
    limpio = limpio.slice(0, -1);
  }
}

/** La dirección a la que lleva un enlace tal y como se escribió. */
export function direccionDe(escrito: string): string {
  if (/^https?:\/\//i.test(escrito)) return escrito;
  return `https://${escrito}`;
}

/** Parte un texto en trozos, separando los enlaces de lo demás. */
export function partirEnEnlaces(texto: string): TrozoDeTexto[] {
  if (!texto) return [];
  const trozos: TrozoDeTexto[] = [];
  let cursor = 0;

  const anadirTexto = (hasta: number) => {
    if (hasta > cursor) trozos.push({ tipo: 'texto', texto: texto.slice(cursor, hasta) });
  };

  PATRON.lastIndex = 0;
  for (let casa = PATRON.exec(texto); casa !== null; casa = PATRON.exec(texto)) {
    const inicio = casa.index;
    const anterior = inicio > 0 ? texto[inicio - 1] : '';
    // Pegado a una arroba, a una letra o a un punto: es parte de otra cosa
    // (un correo, una palabra), no el comienzo de un enlace.
    if (anterior && /[@\w.]/.test(anterior)) continue;

    const escrito = sinPuntuacionFinal(casa[0]);
    if (!escrito) continue;
    // Lo que se recortó del final vuelve a ser texto: el patrón sigue desde ahí.
    PATRON.lastIndex = inicio + escrito.length;

    anadirTexto(inicio);
    trozos.push({ tipo: 'enlace', texto: escrito, direccion: direccionDe(escrito) });
    cursor = inicio + escrito.length;
  }
  anadirTexto(texto.length);
  return trozos;
}

/** Si en el texto hay algún enlace. Para no montar nada de más cuando no lo hay. */
export function tieneEnlaces(texto: string): boolean {
  return partirEnEnlaces(texto).some((trozo) => trozo.tipo === 'enlace');
}

/** Celeste sobre fondo oscuro; azul sobre fondo claro. Los dos se leen subrayados. */
export const ENLACE_SOBRE_OSCURO = '#7CC8FF';
export const ENLACE_SOBRE_CLARO = '#0B63C5';

/**
 * El color del enlace según el color del TEXTO que lo rodea.
 *
 * Se mira la letra y no el fondo porque es lo que ya se sabe en cada burbuja:
 * si la letra es clara, el fondo es oscuro, y al revés. Un color que no se
 * entiende se trata como letra oscura, que es el caso más común.
 */
export function colorDelEnlace(colorDelTexto: string | undefined | null): string {
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((colorDelTexto ?? '').trim())?.[1];
  if (!hex) return ENLACE_SOBRE_CLARO;
  const completo = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex;
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(completo.slice(i, i + 2), 16)) as [number, number, number];
  // Luminancia percibida, de 0 (negro) a 255 (blanco).
  const luz = 0.299 * r + 0.587 * g + 0.114 * b;
  return luz >= 150 ? ENLACE_SOBRE_OSCURO : ENLACE_SOBRE_CLARO;
}
