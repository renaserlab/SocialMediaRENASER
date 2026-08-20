/**
 * Instrumentacion ligera de arranque y carga.
 *
 * Mide cuanto tarda cada hito del flujo real (arranque → feed → primera
 * imagen → primer video) para que las optimizaciones se decidan con numeros y
 * no por intuicion. Apagada no cuesta nada: cada llamada es una comparacion.
 *
 * Se enciende con EXPO_PUBLIC_PERFORMANCE_DEBUG=1 en el .env. No debe quedar
 * activa en produccion: escribe en consola.
 */

const enabled = process.env.EXPO_PUBLIC_PERFORMANCE_DEBUG === '1';

/** Instante de referencia: cuando se evaluo este modulo (arranque del JS). */
const origin = Date.now();

type Marca = { name: string; at: number };

const marcas: Marca[] = [];
const vistas = new Set<string>();

/**
 * Registra un hito. `once` (por defecto) ignora repeticiones del mismo nombre:
 * FIRST_IMAGE_VISIBLE debe medir la primera, no cada imagen del muro.
 */
export function perfMark(name: string, opts: { once?: boolean } = {}): void {
  if (!enabled) return;
  const { once = true } = opts;
  if (once && vistas.has(name)) return;
  vistas.add(name);
  const at = Date.now() - origin;
  marcas.push({ name, at });
  const prev = marcas.length > 1 ? marcas[marcas.length - 2]!.at : 0;
  // eslint-disable-next-line no-console
  console.log(`[perf] ${name} +${at}ms (Δ${at - prev}ms)`);
}

/** Cronometra una operacion concreta (peticiones, firmas, parseos). */
export function perfSpan(name: string): () => void {
  if (!enabled) return () => {};
  const start = Date.now();
  return () => {
    // eslint-disable-next-line no-console
    console.log(`[perf] ${name} tardo ${Date.now() - start}ms`);
  };
}

/** Volcado completo, por si hace falta copiarlo de la consola. */
export function perfDump(): Marca[] {
  return [...marcas];
}
