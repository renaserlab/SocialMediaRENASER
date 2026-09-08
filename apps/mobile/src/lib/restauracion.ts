/**
 * Qué significa de verdad la respuesta del servidor al restaurar compras.
 *
 * POR QUÉ ESTO VIVE AQUÍ Y NO EN `services/compras.ts`. Porque ese fichero
 * importa `react-native`, y entonces la única forma de «probar» esta decisión
 * era buscar subcadenas en su código fuente. Eso ya se intentó y no valía nada:
 * cambiando `granted.length` por `granted.length + 1` la subcadena seguía
 * estando, las 1135 pruebas seguían en verde, y el mensaje falso volvía. Un
 * módulo sin dependencias del aparato se ejecuta de verdad en la prueba.
 *
 * Es el mismo motivo por el que `navigation/atras.ts` existe separado del
 * `useEffect` en el que vivía.
 */

/** Lo que devuelve `POST /payments/native/sync`, en lo que aquí importa. */
export type RespuestaDeSincronizacion = {
  /** Accesos que esta llamada ha CREADO. */
  granted: string[];
  /** Accesos que ya existían y siguen existiendo. */
  unchanged: string[];
};

/**
 * Cuántos accesos tiene esta persona según el servidor.
 *
 * ES LA SUMA, y ahí está todo el asunto. El servidor mete en `granted` solo lo
 * NUEVO: quien ya tenía el acceso concedido —porque llegó el aviso de la
 * tienda, porque la aplicación sincronizó sola al entrar, o porque es el
 * segundo toque del botón— vuelve con `granted: []` y el curso en `unchanged`.
 *
 * Contando solo `granted` se le contesta «no encontramos compras» a alguien que
 * sí pagó. Contando solo que la petición no falló se le contesta «compras
 * restauradas» a quien no tiene ninguna. Las dos son mentiras y las dos se han
 * escrito ya en este fichero; la buena es la suma.
 */
export function accesosTras(respuesta: RespuestaDeSincronizacion): number {
  return respuesta.granted.length + respuesta.unchanged.length;
}
