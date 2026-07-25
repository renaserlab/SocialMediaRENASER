export type TimeFieldProps = {
  label?: string;
  /** Valor en HH:MM (24 h); cadena vacía si aún no hay hora. */
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
};

/**
 * Se guarda en 24 h (HH:MM) porque no admite ambigüedad, y se enseña en el
 * formato de toda la vida («4:00 PM»). Igual que en `DateField`, el formulario
 * sigue hablando en texto: el selector es solo otra forma de rellenarlo.
 */
export function toDisplayTime(date: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** HH:MM -> Date de hoy a esa hora. `null` si no es una hora real. */
export function fromDisplayTime(value: string): Date | null {
  const m = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [, hh, mm] = m;
  const horas = Number(hh);
  const minutos = Number(mm);
  if (horas > 23 || minutos > 59) return null;
  const date = new Date();
  date.setHours(horas, minutos, 0, 0);
  return date;
}

/** HH:MM -> «4:00 PM». Para leerlo, no para guardarlo. */
export function toHumanTime(value: string): string {
  const date = fromDisplayTime(value);
  if (!date) return value;
  const horas = date.getHours();
  const minutos = String(date.getMinutes()).padStart(2, '0');
  const sufijo = horas < 12 ? 'AM' : 'PM';
  // Las 0:xx son las 12 AM, y las 12:xx siguen siendo las 12 PM.
  const doce = horas % 12 === 0 ? 12 : horas % 12;
  return `${doce}:${minutos} ${sufijo}`;
}
