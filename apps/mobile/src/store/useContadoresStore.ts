import { create } from 'zustand';

/**
 * Lo que hay sin leer, en UN sitio.
 *
 * ERAN TRES NÚMEROS QUE NO SE HABLABAN. La campana de Explorar preguntaba su
 * cuenta al volver a esa pestaña; la bandeja de mensajes llevaba la suya en un
 * estado local; y el globo de la barra inferior leía un tercero que, con
 * servidor, estaba siempre a cero porque nadie lo escribía. Por eso llegaba
 * un mensaje y no se movía nada.
 *
 * Aquí viven los dos contadores —avisos y mensajes— y quien los pinta los lee
 * de aquí. Quien se entera de algo nuevo (el push, la lectura periódica, el
 * mensaje que llega en vivo, la pantalla que acaba de marcar como leído) lo
 * escribe aquí.
 *
 * NO SE GUARDA EN DISCO. Es una foto del servidor: persistirla solo serviría
 * para enseñar un número viejo al abrir.
 */
type Contadores = {
  /** Avisos de la bandeja sin leer. */
  notificaciones: number;
  /** Mensajes sin leer, sumando las conversaciones recientes. */
  mensajes: number;
  ponerNotificaciones: (cuenta: number) => void;
  ponerMensajes: (cuenta: number) => void;
  /** Al cerrar sesión: los números de otra cuenta no se heredan. */
  vaciar: () => void;
};

const limpio = (cuenta: number) => (Number.isFinite(cuenta) && cuenta > 0 ? Math.floor(cuenta) : 0);

export const useContadoresStore = create<Contadores>((set) => ({
  notificaciones: 0,
  mensajes: 0,
  ponerNotificaciones: (cuenta) => set({ notificaciones: limpio(cuenta) }),
  ponerMensajes: (cuenta) => set({ mensajes: limpio(cuenta) }),
  vaciar: () => set({ notificaciones: 0, mensajes: 0 }),
}));
