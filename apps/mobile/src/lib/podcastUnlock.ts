/**
 * Liberación progresiva del podcast: un episodio cada 8 horas.
 *
 * El episodio 1 está libre desde el principio y cada siguiente se abre 8 horas
 * después del anterior (8 h, 16 h, 24 h, 32 h). El resto de la lista sigue
 * siendo contenido de membresía y no depende del tiempo.
 *
 * Todo se calcula a partir de UN instante absoluto guardado en el servidor
 * (`podcastStartedAt`). Eso es lo que hace que el desbloqueo siga corriendo con
 * la app cerrada o el móvil apagado: no hay ningún temporizador que mantener
 * vivo, solo una resta contra el reloj actual cada vez que se mira. También
 * evita que se adelante cambiando la hora del teléfono, porque el origen lo
 * pone el backend.
 *
 * Módulo puro (sin React ni acceso a red) para poder razonarlo y probarlo solo.
 */

/** Episodios sujetos a la cuenta atrás. Del siguiente en adelante, membresía. */
export const DRIP_EPISODES = 5;

/** Separación entre un episodio y el siguiente. */
export const UNLOCK_INTERVAL_HOURS = 8;

const HOUR_MS = 60 * 60 * 1000;
const INTERVAL_MS = UNLOCK_INTERVAL_HOURS * HOUR_MS;

/**
 * Estado de una fila de la lista.
 *
 * - `open`: se puede escuchar.
 * - `waiting`: entra dentro de la liberación progresiva pero aún no toca.
 * - `membership`: fuera de los {@link DRIP_EPISODES}; no lo abre el tiempo.
 */
export type EpisodeGate =
  | { state: 'open' }
  | { state: 'waiting'; unlocksAt: number; remainingMs: number }
  | { state: 'membership' };

/** Milisegundos desde `startedAt` hasta que se abre el episodio `index` (base 0). */
export function unlockDelayMs(index: number): number {
  return Math.max(0, index) * INTERVAL_MS;
}

/**
 * Calcula el estado de un episodio.
 *
 * @param index      Posición en la lista, empezando en 0.
 * @param startedAt  Milisegundos del inicio de la liberación; `null` si todavía
 *                   no ha arrancado (se trata como "acaba de empezar", de modo
 *                   que el primero se ve libre y el resto en cuenta atrás).
 * @param now        Reloj actual, inyectado para que la función sea pura.
 */
export function gateFor(index: number, startedAt: number | null, now: number): EpisodeGate {
  if (index >= DRIP_EPISODES) return { state: 'membership' };
  // Sin instante de inicio el primero ya es gratuito; asumir "ahora" para el
  // resto muestra la cuenta atrás completa en lugar de un hueco sin explicar.
  const origin = startedAt ?? now;
  const unlocksAt = origin + unlockDelayMs(index);
  if (now >= unlocksAt) return { state: 'open' };
  return { state: 'waiting', unlocksAt, remainingMs: unlocksAt - now };
}

/** `true` si todavía queda algún episodio por abrirse (hay algo que contar). */
export function hasPendingUnlocks(startedAt: number | null, now: number): boolean {
  const origin = startedAt ?? now;
  return now < origin + unlockDelayMs(DRIP_EPISODES - 1);
}

/**
 * Cuenta atrás como `HH:MM:SS`.
 *
 * Las horas no se limitan a dos dígitos ni pasan a días: el máximo del podcast
 * son 32 horas y verlas seguidas se entiende mejor que "1 d 8 h".
 */
export function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Texto de la espera: "Audio disponible dentro de 8 horas".
 *
 * Redondea hacia arriba para no decir "0 horas" durante los últimos 59 minutos;
 * el contador de al lado ya da el detalle al segundo.
 */
export function waitingLabel(remainingMs: number): string {
  const hours = Math.ceil(remainingMs / HOUR_MS);
  if (hours <= 1) return 'Audio disponible dentro de 1 hora';
  return `Audio disponible dentro de ${hours} horas`;
}
