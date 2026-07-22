/**
 * Latencia simulada para mostrar estados de carga reales mientras la app usa
 * datos mock. Al integrar el backend, las llamadas reales aportan su propia
 * latencia y este helper deja de usarse en las ramas remotas.
 */
// Suficiente para que el skeleton sea visible, sin penalizar cada navegación.
export const MOCK_LATENCY_MS = 250;

export const mockDelay = (ms: number = MOCK_LATENCY_MS) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
