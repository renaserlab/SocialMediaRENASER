/**
 * Disponibilidad para las sesiones 1:1: la semana tipo de cada persona.
 *
 * LO QUE SE PIDIÓ (07/10/2026): que cada usuario defina en qué días y horarios
 * está disponible, y que quien le pide una sesión elija entre esos horarios.
 *
 * ES UN PROTOTIPO. Una semana que se repite, sesiones de una hora, sin
 * excepciones por fecha. Las reglas de verdad están en el servidor
 * (`bookings/disponibilidad.py`); aquí está lo que se puede probar sin red:
 * leer lo que manda, validar una franja antes de mandarla y agrupar los huecos
 * por día. Sin importaciones, a propósito.
 */

/** Lo que dura una sesión. Igual que en el servidor. */
export const MINUTOS_DE_SESION = 60;
/** Franjas por día, como mucho. Igual que en el servidor. */
export const FRANJAS_POR_DIA = 4;
/** Los días de la semana: 0 = lunes … 6 = domingo. */
export const DIAS_DE_LA_SEMANA = [0, 1, 2, 3, 4, 5, 6] as const;

export type Franja = {
  /** 0 = lunes … 6 = domingo. */
  dia: number;
  /** HH:MM, 24 h. */
  desde: string;
  hasta: string;
};

export type Hueco = {
  empiezaIso: string;
  terminaIso: string;
};

/** De «09:30» a 570. `null` si no es una hora. «24:00» vale como fin de día. */
export function aMinutos(texto: string): number | null {
  const casa = /^(\d{1,2}):(\d{2})$/.exec(texto.trim());
  if (!casa) return null;
  const horas = Number(casa[1]);
  const minutos = Number(casa[2]);
  if (horas === 24 && minutos === 0) return 1440;
  if (horas > 23 || minutos > 59) return null;
  return horas * 60 + minutos;
}

export type JuicioDeFranja =
  | 'vale'
  /** Falta una hora, o no se entiende. */
  | 'hora'
  /** No da para una sesión entera. */
  | 'corta'
  /** Se pisa con otra del mismo día. */
  | 'se_pisa'
  /** Ese día ya tiene todas las que caben. */
  | 'llena';

/**
 * Si una franja nueva se puede añadir a las que ya hay.
 *
 * Es cortesía: quien decide es el servidor, con estas mismas reglas. Lo que
 * aporta aquí es decir QUÉ falla antes de guardar la semana entera.
 */
export function juzgarFranja(nueva: Franja, existentes: readonly Franja[]): JuicioDeFranja {
  const inicio = aMinutos(nueva.desde);
  const fin = aMinutos(nueva.hasta);
  if (inicio === null || fin === null) return 'hora';
  if (fin - inicio < MINUTOS_DE_SESION) return 'corta';
  const delDia = existentes.filter((f) => f.dia === nueva.dia);
  if (delDia.length >= FRANJAS_POR_DIA) return 'llena';
  for (const otra of delDia) {
    const a = aMinutos(otra.desde);
    const b = aMinutos(otra.hasta);
    if (a === null || b === null) continue;
    if (inicio < b && a < fin) return 'se_pisa';
  }
  return 'vale';
}

/** Por día y, dentro del día, por hora de comienzo. No toca la lista original. */
export function ordenarFranjas(franjas: readonly Franja[]): Franja[] {
  return [...franjas].sort(
    (a, b) => a.dia - b.dia || (aMinutos(a.desde) ?? 0) - (aMinutos(b.desde) ?? 0),
  );
}

export type Disponibilidad = {
  /** `false` si el servidor todavía no tiene esta función. */
  disponible: boolean;
  zona: string;
  franjas: Franja[];
};

/** De lo que manda el servidor a lo que usa la pantalla. `null` si no lo es. */
export function leerDisponibilidad(bruto: unknown): Disponibilidad | null {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return null;
  const dto = bruto as Record<string, unknown>;
  if (typeof dto.available !== 'boolean') return null;
  const franjas: Franja[] = [];
  for (const fila of Array.isArray(dto.slots) ? dto.slots : []) {
    if (!fila || typeof fila !== 'object') continue;
    const f = fila as Record<string, unknown>;
    if (
      typeof f.weekday !== 'number' ||
      f.weekday < 0 ||
      f.weekday > 6 ||
      typeof f.start !== 'string' ||
      typeof f.end !== 'string' ||
      aMinutos(f.start) === null ||
      aMinutos(f.end) === null
    ) {
      continue;
    }
    franjas.push({ dia: f.weekday, desde: f.start, hasta: f.end });
  }
  return {
    disponible: dto.available,
    zona: typeof dto.timezone === 'string' && dto.timezone ? dto.timezone : 'America/Lima',
    franjas: ordenarFranjas(franjas),
  };
}

/** Los huecos que se le pueden pedir a una persona. Vacío si no hay o no se entiende. */
export function leerHuecos(bruto: unknown): Hueco[] {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return [];
  const dto = bruto as Record<string, unknown>;
  if (dto.available !== true || !Array.isArray(dto.openings)) return [];
  const huecos: Hueco[] = [];
  for (const fila of dto.openings) {
    if (!fila || typeof fila !== 'object') continue;
    const f = fila as Record<string, unknown>;
    if (typeof f.starts_at !== 'string' || typeof f.ends_at !== 'string') continue;
    if (Number.isNaN(new Date(f.starts_at).getTime())) continue;
    huecos.push({ empiezaIso: f.starts_at, terminaIso: f.ends_at });
  }
  return huecos;
}

const dos = (n: number) => String(n).padStart(2, '0');

/**
 * Un hueco, dicho en la hora DEL TELÉFONO de quien pide: la fecha y la hora
 * tal y como las entienden los campos del formulario («13/10/2026», «09:00»).
 *
 * El servidor manda instantes; cada cual los ve en su hora. Quien está en otro
 * país ve el mismo hueco a otra hora, que es lo correcto.
 */
export function aFechaYHora(iso: string): { fecha: string; hora: string } {
  const d = new Date(iso);
  return {
    fecha: `${dos(d.getDate())}/${dos(d.getMonth() + 1)}/${d.getFullYear()}`,
    hora: `${dos(d.getHours())}:${dos(d.getMinutes())}`,
  };
}

export type HuecosDeUnDia = { fecha: string; huecos: Hueco[] };

/** Los huecos agrupados por día (en la hora del teléfono), en el orden en que llegan. */
export function agruparPorDia(huecos: readonly Hueco[]): HuecosDeUnDia[] {
  const dias: HuecosDeUnDia[] = [];
  for (const hueco of huecos) {
    const { fecha } = aFechaYHora(hueco.empiezaIso);
    const ultimo = dias[dias.length - 1];
    if (ultimo && ultimo.fecha === fecha) ultimo.huecos.push(hueco);
    else dias.push({ fecha, huecos: [hueco] });
  }
  return dias;
}
