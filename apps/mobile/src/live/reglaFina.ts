/**
 * Las barras finas de la hoja del texto (tamaño y giro): del sitio del dedo al
 * valor, con su paso y su imán. Como la barra de «Mejorar», pero con su propio
 * recorrido: el tamaño va de 70 a 240 % y el giro de −180 a 180°.
 *
 * Sin React y sin importaciones, para probarlo con el runner de Node. Los
 * rangos son los de `live/destacado.ts` (los del servidor): la prueba exige que
 * coincidan.
 */
export type Regla = {
  minimo: number;
  maximo: number;
  /** El valor siempre es un múltiplo de esto. */
  paso: number;
  /** Donde se engancha: lo de siempre (100 %, 0°). */
  iman: number;
  /** Lo que mueve cada gesto del lector de pantalla o cada flecha. */
  pasoDeAccesibilidad: number;
  /**
   * El relleno sale del imán y no del principio: en el giro, a la izquierda
   * es girar a un lado y a la derecha al otro.
   */
  rellenoDesdeElIman: boolean;
};

/** Cuánto del recorrido engancha el imán, a cada lado. */
export const MARGEN_DEL_IMAN = 0.015;

export const REGLA_DE_TAMANO: Regla = {
  minimo: 70,
  maximo: 240,
  paso: 5,
  iman: 100,
  pasoDeAccesibilidad: 5,
  rellenoDesdeElIman: false,
};

export const REGLA_DE_GIRO: Regla = {
  minimo: -180,
  maximo: 180,
  paso: 1,
  iman: 0,
  pasoDeAccesibilidad: 5,
  rellenoDesdeElIman: true,
};

function entre(valor: number, minimo: number, maximo: number): number {
  return Math.min(maximo, Math.max(minimo, valor));
}

/** El valor válido más cercano: dentro del recorrido y en su paso. */
export function ajustarALaRegla(valor: number, regla: Regla): number {
  if (!Number.isFinite(valor)) return regla.iman;
  const redondo = Math.round(valor / regla.paso) * regla.paso;
  // `+ 0`: que un −0 no se pinte como «-0°».
  return entre(redondo, regla.minimo, regla.maximo) + 0;
}

/** Dónde cae un valor en la barra, de 0 (izquierda) a 1 (derecha). */
export function fraccionDe(valor: number, regla: Regla): number {
  const recorrido = regla.maximo - regla.minimo;
  if (!(recorrido > 0) || !Number.isFinite(valor)) return 0;
  return entre((valor - regla.minimo) / recorrido, 0, 1);
}

/** El valor de un sitio de la barra (0–1). Cerca del imán, el imán. */
export function valorEn(fraccion: number, regla: Regla): number {
  if (!Number.isFinite(fraccion)) return regla.iman;
  const recorrido = regla.maximo - regla.minimo;
  const crudo = regla.minimo + entre(fraccion, 0, 1) * recorrido;
  if (Math.abs(crudo - regla.iman) <= MARGEN_DEL_IMAN * recorrido) return regla.iman;
  return ajustarALaRegla(crudo, regla);
}

/** Un paso arriba o abajo, para el lector de pantalla y las flechas. */
export function pasoEnLaRegla(valor: number, sentido: 1 | -1, regla: Regla): number {
  return ajustarALaRegla(valor + sentido * regla.pasoDeAccesibilidad, regla);
}

/** Lo que va relleno de la barra, en fracciones: del principio o del imán al valor. */
export function tramoRelleno(valor: number, regla: Regla): { desde: number; hasta: number } {
  const aqui = fraccionDe(valor, regla);
  if (!regla.rellenoDesdeElIman) return { desde: 0, hasta: aqui };
  const iman = fraccionDe(regla.iman, regla);
  return { desde: Math.min(iman, aqui), hasta: Math.max(iman, aqui) };
}
