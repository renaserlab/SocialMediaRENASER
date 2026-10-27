import { contraste, elMasLegible } from '@/lib/contrasteDeColor';
import { ENLACE_SOBRE_CLARO, ENLACE_SOBRE_OSCURO } from '@/lib/enlacesEnTexto';
import { COLOR_DE_LEIDO } from '@/lib/lecturaDeMensajes';

/*
  EL COLOR DE «LEÍDO» Y DE LOS ENLACES, POR CONTRASTE CON SU FONDO.

  Antes se elegía por el MODO (claro/oscuro), dando por hecho que la burbuja
  propia es negra en claro y blanca en oscuro. Con una burbuja de color —un
  tema— eso deja de ser verdad: «leído» en celeste sobre una burbuja celeste
  no se ve, y es el único sitio donde se distingue de «entregado».

  Con la burbuja negra o blanca de siempre sale EXACTAMENTE lo de antes: los
  dos candidatos son los mismos y gana el que ganaba.

  Vive aparte (y no dentro de `lecturaDeMensajes` / `enlacesEnTexto`) porque
  esos módulos no importan nada y sus pruebas los cargan con Node, que no
  resuelve el alias `@/`.
*/

/** Por debajo de esto un color sobre su fondo se lee mal (WCAG, elementos gráficos). */
const MINIMO = 3;

/** Reservas de «leído» cuando ni el celeste ni el azul de siempre se leen. */
const AZUL_PROFUNDO = '#003A8C';
const AZUL_CLARO = '#BDE6FF';

/**
 * El color de las marcas de «leído» sobre `fondo`. `entregado` es el color de
 * las marcas sin leer: nunca se devuelve ese, o leído y entregado serían
 * iguales. `null` si el fondo no se entiende (quien llama usa lo de antes).
 */
export function colorDeLeidoSobre(fondo: string, entregado?: string): string | null {
  const distintoDeEntregado = (c: string) =>
    !entregado || c.toLowerCase() !== entregado.trim().toLowerCase();
  /*
    Por tramos: primero los dos de siempre; si ninguno se lee, dos azules de
    reserva (uno profundo para burbujas claras, uno claro para las oscuras),
    para que «leído» siga siendo azul; y solo al final blanco o negro.
  */
  const tramos = [
    [COLOR_DE_LEIDO.sobreOscuro, COLOR_DE_LEIDO.sobreClaro],
    [AZUL_PROFUNDO, AZUL_CLARO],
    ['#FFFFFF', '#000000'],
  ];
  let ultimo: string | null = null;
  for (const tramo of tramos) {
    const mejor = elMasLegible(fondo, tramo.filter(distintoDeEntregado));
    if (mejor === null) return ultimo;
    if ((contraste(fondo, mejor) ?? 0) >= MINIMO) return mejor;
    ultimo = ultimo && (contraste(fondo, ultimo) ?? 0) >= (contraste(fondo, mejor) ?? 0) ? ultimo : mejor;
  }
  return ultimo;
}

/**
 * El color de un enlace escrito sobre `fondo` con letra `letra`. Si ni el
 * celeste ni el azul se leen, el de la letra: el subrayado sigue diciendo que
 * es un enlace. `null` si el fondo no se entiende.
 */
export function colorDelEnlaceSobre(fondo: string, letra: string): string | null {
  const mejor = elMasLegible(fondo, [ENLACE_SOBRE_OSCURO, ENLACE_SOBRE_CLARO]);
  if (mejor === null) return null;
  return (contraste(fondo, mejor) ?? 0) >= MINIMO ? mejor : letra;
}
