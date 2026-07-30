/**
 * Convierte cualquier cosa lanzada en un texto util para quien usa la app.
 *
 * ## Por que hace falta
 *
 * El patron habitual `error instanceof Error ? error.message : 'Inténtalo de
 * nuevo.'` pierde el motivo real siempre que lo lanzado NO es un `Error`
 * estandar. Y eso pasa a menudo con los modulos nativos de Expo, que lanzan
 * objetos con `code` y `message` propios sin heredar de `Error`.
 *
 * El resultado era el peor de los mundos: un aviso que dice "Inténtalo de
 * nuevo" mientras el motivo concreto —permiso, camara ocupada, sin espacio— se
 * tira a la basura. Con eso no se puede diagnosticar nada, ni desde dentro de
 * la app ni leyendo un aviso en una captura de pantalla.
 *
 * Ademas registra en consola el objeto completo, que es lo que sirve cuando hay
 * que mirar los logs de Metro.
 */
export function describeError(error: unknown, fallback: string): string {
  // Siempre al log: aunque se devuelva un texto legible, el objeto entero
  // suele tener mas (codigo nativo, causa, pila).
  console.warn('[error]', error);

  if (error instanceof Error && error.message) return error.message;

  if (typeof error === 'string' && error.trim()) return error;

  if (error && typeof error === 'object') {
    const posible = error as { message?: unknown; code?: unknown };
    const message = typeof posible.message === 'string' ? posible.message.trim() : '';
    const code = typeof posible.code === 'string' ? posible.code.trim() : '';
    // El codigo se incluye porque muchos errores nativos traen un `code`
    // reconocible y un `message` vago, o al reves.
    if (message && code) return `${message} (${code})`;
    if (message) return message;
    if (code) return code;
  }

  return fallback;
}
