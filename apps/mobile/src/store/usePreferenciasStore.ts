import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

import { RecommendationRepository } from '@/repositories/RecommendationRepository';

/**
 * Si a esta persona hay que ensenarle el cuestionario de recomendacion.
 *
 * LA FUENTE DE VERDAD ES EL SERVIDOR, no este store. Si lo decidiera el
 * telefono, cambiar de dispositivo volveria a preguntarlo todo y dos versiones
 * de la aplicacion podrian discrepar sobre la misma cuenta. Lo que hay aqui es
 * una CACHE, y existe por un motivo concreto: el arranque no puede quedarse
 * esperando a una respuesta de red para decidir a que pantalla ir.
 *
 * El acuerdo con el arranque (`app/index.tsx`) es que `estado` SIEMPRE sale de
 * 'desconocido' en un tiempo acotado. Pase lo que pase con la red.
 */

export type EstadoDelCuestionario =
  /** Todavia no se sabe. El arranque espera, pero poco. */
  | 'desconocido'
  /** Hay que ensenarlo. */
  | 'pendiente'
  /** Ya paso por el (respondiendo o saltandoselo). */
  | 'visto'
  /**
   * No se pudo preguntar, o la personalizacion esta apagada en el servidor.
   * La aplicacion sigue como siempre: no se ensena el cuestionario, y desde
   * luego no se bloquea a nadie por no poder preguntarlo.
   */
  | 'noDisponible';

/**
 * Cuanto espera el arranque a saberlo, la PRIMERA vez en este dispositivo.
 *
 * El backend vive en un plan que suspende la instancia y puede tardar ~25 s en
 * despertar. Esperarlos seria dejar a alguien mirando una rueda girar para
 * decidir si mostrarle un cuestionario. Se espera lo justo, se continua, y la
 * respuesta que llegue tarde queda guardada para el proximo arranque.
 */
const ESPERA_MAXIMA_MS = 2500;

const CLAVE = 'z.cuestionario.v1';

type CacheEnDisco = Record<string, 'pendiente' | 'visto'>;

async function leerCache(): Promise<CacheEnDisco> {
  try {
    const crudo = await AsyncStorage.getItem(CLAVE);
    return crudo ? (JSON.parse(crudo) as CacheEnDisco) : {};
  } catch {
    // Un disco que falla no puede impedir entrar en la aplicacion.
    return {};
  }
}

async function escribirCache(usuarioId: string, valor: 'pendiente' | 'visto') {
  try {
    const cache = await leerCache();
    await AsyncStorage.setItem(CLAVE, JSON.stringify({ ...cache, [usuarioId]: valor }));
  } catch {
    // Sin cache la aplicacion funciona igual: solo espera un poco al arrancar.
  }
}

type PreferenciasState = {
  estado: EstadoDelCuestionario;
  /** A quien pertenece el estado actual. Cambiar de cuenta lo invalida. */
  usuarioId: string | null;

  /**
   * Resuelve el estado para este usuario. Devuelve cuando ya se puede decidir
   * a donde ir: con la respuesta del servidor, con la cache o por tiempo.
   */
  cargarEstado: (usuarioId: string) => Promise<EstadoDelCuestionario>;
  /** El cuestionario se respondio o se salto: no se vuelve a ensenar. */
  marcarVisto: () => void;
  /** Al cerrar sesion. Lo de la cuenta anterior no vale para la siguiente. */
  reiniciar: () => void;
};

export const usePreferenciasStore = create<PreferenciasState>((set, get) => ({
  estado: 'desconocido',
  usuarioId: null,

  async cargarEstado(usuarioId) {
    // Ya resuelto para esta misma persona: no se vuelve a preguntar.
    if (get().usuarioId === usuarioId && get().estado !== 'desconocido') {
      return get().estado;
    }
    set({ usuarioId, estado: 'desconocido' });

    const cache = await leerCache();
    const guardado = cache[usuarioId];

    /*
      Con la respuesta cacheada se decide YA. La red sigue por detras y corrige
      lo que haga falta: si en otro telefono se completo el cuestionario, la
      correccion llega en cuanto responde el servidor y esta persona no lo
      vuelve a ver.
    */
    const consulta = RecommendationRepository.getOnboardingStatus()
      .then((estado) => {
        const siguiente = estado.shouldShow ? 'pendiente' : 'visto';
        void escribirCache(usuarioId, siguiente);
        if (get().usuarioId === usuarioId) set({ estado: siguiente });
        return siguiente as EstadoDelCuestionario;
      })
      .catch((error) => {
        // No poder preguntar NO es «hay que ensenarlo»: ante la duda, no se
        // interrumpe a nadie con un cuestionario.
        console.warn('[preferencias] no se pudo consultar el cuestionario', error);
        if (get().usuarioId === usuarioId && get().estado === 'desconocido') {
          set({ estado: guardado ?? 'noDisponible' });
        }
        return (guardado ?? 'noDisponible') as EstadoDelCuestionario;
      });

    if (guardado) {
      set({ estado: guardado });
      return guardado;
    }

    // Primera vez en este dispositivo: se espera, pero con reloj.
    const porTiempo = new Promise<EstadoDelCuestionario>((resolve) => {
      setTimeout(() => resolve('noDisponible'), ESPERA_MAXIMA_MS);
    });
    const resultado = await Promise.race([consulta, porTiempo]);
    if (get().estado === 'desconocido') set({ estado: resultado });
    return get().estado;
  },

  marcarVisto() {
    const { usuarioId } = get();
    if (usuarioId) void escribirCache(usuarioId, 'visto');
    set({ estado: 'visto' });
  },

  reiniciar() {
    set({ estado: 'desconocido', usuarioId: null });
  },
}));
