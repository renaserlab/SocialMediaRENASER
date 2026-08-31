export type DateFieldProps = {
  label?: string;
  /** Valor en dd/mm/aaaa; cadena vacía si aún no hay fecha. */
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /**
   * Primer día que se puede elegir. Sin valor, cualquiera.
   *
   * NO ES LA VALIDACIÓN, es la cortesía: quien decide si una fecha vale es el
   * servidor, con SU reloj (ver `es_momento_futuro` en la agenda). Esto solo
   * evita ofrecer días que se van a rechazar — un calendario que deja elegir
   * el martes pasado y después dice que no es un calendario que se equivoca a
   * propósito.
   */
  minDate?: Date;
};

/** Date -> aaaa-mm-dd, para el atributo `min` de `<input type="date">`. */
export function toIsoDate(date: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/**
 * HOY a las 00:00, en la zona horaria del teléfono.
 *
 * A MEDIANOCHE Y NO «AHORA MISMO», y la diferencia importa: con `new Date()` el
 * calendario dejaría de ofrecer el día de hoy en cuanto pasara un minuto, y una
 * sesión para esta tarde es lo más normal del mundo. El límite fino —que la
 * HORA elegida tampoco haya pasado— es de quien componga fecha y hora, y la
 * palabra definitiva la tiene el servidor.
 */
export function hoyANoche(): Date {
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  return hoy;
}

/**
 * El formulario sigue hablando en dd/mm/aaaa y la validación no cambia: el
 * selector es solo otra forma de rellenar el mismo campo, así que se convierte
 * aquí y no se propaga un tipo nuevo por toda la pantalla.
 */
export function toDisplay(date: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(date.getDate())}/${two(date.getMonth() + 1)}/${date.getFullYear()}`;
}

/** dd/mm/aaaa -> Date. `null` si está vacío o no es una fecha real. */
export function fromDisplay(value: string): Date | null {
  const m = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const date = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  // Rechaza fechas imposibles (31/02) que Date normalizaría en silencio.
  if (
    date.getFullYear() !== Number(yyyy) ||
    date.getMonth() !== Number(mm) - 1 ||
    date.getDate() !== Number(dd)
  ) {
    return null;
  }
  return date;
}

/** dd/mm/aaaa -> aaaa-mm-dd, que es lo que espera <input type="date">. */
export function toIso(value: string): string {
  const date = fromDisplay(value);
  if (!date) return '';
  const two = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** aaaa-mm-dd -> dd/mm/aaaa. */
export function fromIso(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  return `${m[3]}/${m[2]}/${m[1]}`;
}
