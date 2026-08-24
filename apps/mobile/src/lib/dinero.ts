/**
 * Dinero: siempre en la unidad MENOR, nunca en decimales.
 *
 * POR QUE ESTE FICHERO EXISTE. El precio de un curso viajaba como entero en la
 * unidad mayor y el servidor lo multiplicaba por 100, asi que «49.90» no se
 * podia expresar: llegaba como 49 y se guardaba 4900. Un precio que el creador
 * escribe y el sistema cambia en silencio no es un precio, es un error
 * esperando a que alguien compre.
 *
 * Y POR QUE ESTA APARTE. Porque el calculo tiene que ocurrir en UN sitio. Un
 * `Math.round(Number(texto) * 100)` repartido por tres componentes son tres
 * reglas que se parecen, y basta con que una redondee distinto para que el
 * precio del formulario y el del resumen no coincidan. Aqui esta escrito una
 * vez y probado.
 *
 * El redondeo NO es `Number(x) * 100`: en coma flotante `49.90 * 100` da
 * 4989.999999999999, que truncado es 4989. Un centimo perdido por curso, en la
 * direccion de cobrar de menos, y sin que nadie lo vea nunca.
 */

/** Lo que devuelve leer un importe escrito por una persona. */
export type ImporteLeido =
  | { ok: true; centavos: number }
  | { ok: false; motivo: string };

/** Como maximo dos decimales, con coma o con punto, sin signo. */
const FORMATO = /^\d+(?:[.,]\d{1,2})?$/;

/**
 * Convierte lo que alguien escribio en centavos.
 *
 * Se acepta la coma ademas del punto porque es lo que produce el teclado
 * numerico en castellano, y rechazar «49,90» por eso seria culpar a quien
 * escribe de una decision nuestra.
 */
export function aCentavos(texto: string): ImporteLeido {
  const limpio = (texto ?? '').trim();
  if (limpio === '') return { ok: false, motivo: 'Escribe un precio.' };
  if (!FORMATO.test(limpio)) {
    return {
      ok: false,
      motivo: 'Escribe un número como 49.90, sin símbolos ni espacios.',
    };
  }

  const [enteros, decimales = ''] = limpio.replace(',', '.').split('.');
  // Se compone con enteros, no multiplicando: asi no hay coma flotante por
  // medio y `49.90` es exactamente 4990, no 4989.999…
  const centavos = Number(enteros) * 100 + Number(decimales.padEnd(2, '0'));

  if (!Number.isSafeInteger(centavos)) {
    return { ok: false, motivo: 'Ese precio es demasiado alto.' };
  }
  if (centavos > 100_000_000) {
    return { ok: false, motivo: 'Ese precio es demasiado alto.' };
  }
  return { ok: true, centavos };
}

const SIMBOLOS: Record<string, string> = {
  PEN: 'S/',
  MXN: '$',
  USD: '$',
};

/**
 * De centavos a algo que se pueda leer.
 *
 * Siempre con los dos decimales: «S/ 49.9» parece un precio a medio escribir, y
 * «S/ 50» sobre 4990 seria mentir por un centimo.
 */
export function deCentavos(centavos: number, moneda = 'PEN'): string {
  const valor = Math.max(0, Math.round(centavos ?? 0));
  const enteros = Math.floor(valor / 100);
  const resto = String(valor % 100).padStart(2, '0');
  const simbolo = SIMBOLOS[moneda] ?? '';
  return `${simbolo}${simbolo ? ' ' : ''}${enteros}.${resto}`.trim();
}

/**
 * Lo que se ensena cuando el precio ES la informacion: gratis o cuanto cuesta.
 *
 * «Gratis» y no «S/ 0.00» porque son dos afirmaciones distintas: la segunda
 * suena a que el precio todavia no esta puesto.
 */
export function etiquetaDePrecio(centavos: number, moneda = 'PEN'): string {
  return centavos > 0 ? deCentavos(centavos, moneda) : 'Gratis';
}

/** Para rellenar el formulario de edicion con lo que ya estaba guardado. */
export function aTextoEditable(centavos: number): string {
  if (!centavos) return '';
  return `${Math.floor(centavos / 100)}.${String(centavos % 100).padStart(2, '0')}`;
}
