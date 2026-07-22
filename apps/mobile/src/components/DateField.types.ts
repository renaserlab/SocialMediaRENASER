export type DateFieldProps = {
  label?: string;
  /** Valor en dd/mm/aaaa; cadena vacía si aún no hay fecha. */
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
};

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
