import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Qué toques de notificación YA se atendieron, también entre una apertura y la
 * siguiente.
 *
 * POR QUÉ HACE FALTA GUARDARLO. Tocar un aviso abre aquello de lo que habla, UNA
 * vez. Pero el sistema sigue entregando ese mismo toque cada vez que la
 * aplicación arranca —Android relanza la tarea con la intención original, y la
 * biblioteca de avisos lo devuelve como «la última respuesta»—. Sin recordarlo,
 * cada arranque volvía a abrir aquel chat. Con la memoria solo en el
 * componente, además, bastaba que el layout se volviera a montar para
 * repetirlo (ver `lib/navegadorMontado.ts`).
 *
 * NINGUNA DE ESTAS FUNCIONES LANZA: si el disco falla se contesta «no atendido»
 * o no se guarda. Lo peor que pasa entonces es abrir un aviso dos veces.
 */
const CLAVE = 'z.push.atendidos.v1';
/** Con unos pocos basta: el sistema solo repite el último. */
const RECORDADOS = 20;

/** Los de este proceso. Vive fuera de React a propósito. */
const enMemoria = new Set<string>();

async function leer(): Promise<string[]> {
  try {
    const crudo = await AsyncStorage.getItem(CLAVE);
    const lista: unknown = crudo ? JSON.parse(crudo) : [];
    return Array.isArray(lista) ? lista.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Reserva el toque para atenderlo. `false` si ya se atendió —en este proceso o
 * en una apertura anterior—: entonces no hay que hacer nada con él.
 *
 * La reserva en memoria es inmediata (antes de la primera espera), para que
 * dos lecturas casi simultáneas del mismo toque no pasen las dos.
 */
export async function reservarToque(identificador: string): Promise<boolean> {
  if (enMemoria.has(identificador)) return false;
  enMemoria.add(identificador);
  const guardados = await leer();
  return !guardados.includes(identificador);
}

/** El toque ya llevó a donde tenía que llevar: no se repite nunca más. */
export async function anotarToqueAtendido(identificador: string): Promise<void> {
  enMemoria.add(identificador);
  try {
    const guardados = await leer();
    if (guardados.includes(identificador)) return;
    await AsyncStorage.setItem(CLAVE, JSON.stringify([...guardados, identificador].slice(-RECORDADOS)));
  } catch {
    // Sin disco queda la memoria de este proceso.
  }
}

/** No llegó a atenderse (el componente se fue antes): que otro intento pueda. */
export function soltarToque(identificador: string): void {
  enMemoria.delete(identificador);
}

/** Solo para las pruebas. */
export function olvidarToques(): void {
  enMemoria.clear();
}
