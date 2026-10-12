import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { create } from 'zustand';

import {
  CLAVE_DEL_FONDO_COMUN,
  CLAVE_DE_FONDOS,
  conFondo,
  escribirFondos,
  fondoDe,
  leerFondo,
  leerFondos,
  type FondoDeChat,
  type FondosPorChat,
} from '@/lib/fondoDeChat';

/**
 * El fondo que esta persona eligió para cada chat EN ESTE TELÉFONO.
 *
 * CADA CONVERSACIÓN TIENE EL SUYO. Cambiar el de un grupo no toca ningún otro
 * chat. No viaja al servidor: es cómo quiere ver sus chats aquí, y nadie más
 * lo ve. Se lee del disco una vez por sesión y se guarda al cambiarlo.
 *
 * UNA FOTO SE COPIA A LA CARPETA DE LA APLICACIÓN. El selector entrega una
 * ruta de la caché, que el sistema puede vaciar cuando quiera: guardar esa
 * ruta dejaría el chat sin fondo cualquier día. Se guarda la copia, y la
 * anterior de ese chat se borra al cambiarla.
 */
type Estado = {
  fondos: FondosPorChat;
  /** Ya se ha leído lo guardado: hasta entonces se pinta el fondo de siempre. */
  leido: boolean;
  leer: () => Promise<void>;
  /** Cambia el fondo de ESA conversación. */
  elegir: (conversacionId: string, fondo: FondoDeChat) => Promise<void>;
  /** Pone como fondo de esa conversación una foto recién elegida. `false` si no se pudo. */
  elegirFoto: (conversacionId: string, uri: string) => Promise<boolean>;
};

/** Se pueden usar fotos: en web la ruta de una foto elegida no sobrevive a recargar. */
export const FONDO_CON_FOTO = Platform.OS !== 'web';

const NOMBRE_DE_LA_COPIA = 'fondo-del-chat';

function borrarCopia(uri: string | null | undefined): void {
  if (!uri || !FONDO_CON_FOTO) return;
  try {
    const copia = new File(uri);
    if (copia.exists) copia.delete();
  } catch {
    // Una copia que no se puede borrar ocupa sitio; no rompe nada.
  }
}

/** Copia la foto a la carpeta de la aplicación y devuelve dónde quedó. */
function copiarFoto(uri: string): string {
  const extension = /\.(jpe?g|png|webp|heic)$/i.exec(uri)?.[1]?.toLowerCase() ?? 'jpg';
  // El nombre cambia con cada foto: con el mismo, la imagen anterior seguiría
  // en pantalla porque ya estaba cargada con esa dirección.
  const destino = new File(Paths.document, `${NOMBRE_DE_LA_COPIA}-${Date.now()}.${extension}`);
  new File(uri).copy(destino);
  return destino.uri;
}

async function guardar(fondos: FondosPorChat): Promise<void> {
  try {
    await AsyncStorage.setItem(CLAVE_DE_FONDOS, escribirFondos(fondos));
  } catch {
    // Sin disco, el fondo vale hasta cerrar la aplicación. Se ve igual.
  }
}

/**
 * Retira el fondo de cuando era uno solo para todos los chats.
 *
 * No se le pone a ningún chat: no se sabe en cuál se eligió. Si era una foto,
 * su copia se borra para que no se quede ocupando sitio sin que nadie la use.
 */
async function retirarElFondoComun(): Promise<void> {
  try {
    const guardado = await AsyncStorage.getItem(CLAVE_DEL_FONDO_COMUN);
    if (guardado === null) return;
    const comun = leerFondo(guardado);
    if (comun.tipo === 'foto') borrarCopia(comun.uri);
    await AsyncStorage.removeItem(CLAVE_DEL_FONDO_COMUN);
  } catch {
    // Si no se puede retirar hoy, se retira otro día. No se pinta en ningún caso.
  }
}

async function leerDelDisco(): Promise<FondosPorChat> {
  let fondos: FondosPorChat = {};
  try {
    fondos = leerFondos(await AsyncStorage.getItem(CLAVE_DE_FONDOS));
  } catch {
    // Lo que no se puede leer es «sin fondos»: todos los chats, como siempre.
  }
  // Una foto guardada donde no se pueden usar fotos no se intenta pintar.
  if (!FONDO_CON_FOTO) {
    fondos = Object.fromEntries(Object.entries(fondos).filter(([, fondo]) => fondo.tipo !== 'foto'));
  }
  await retirarElFondoComun();
  return fondos;
}

/** La lectura en curso: quien llega mientras tanto espera a la misma. */
let leyendo: Promise<void> | null = null;

export const useFondoDeChatStore = create<Estado>((set, get) => ({
  fondos: {},
  leido: false,

  leer() {
    if (get().leido) return Promise.resolve();
    leyendo ??= leerDelDisco()
      .then((fondos) => set({ fondos, leido: true }))
      .finally(() => {
        leyendo = null;
      });
    return leyendo;
  },

  async elegir(conversacionId, fondo) {
    if (!conversacionId) return;
    // Antes de cambiar uno hay que tener TODOS: lo que se guarda es la lista
    // entera, y guardarla a medio leer borraría los fondos de los demás chats.
    await get().leer();
    const anterior = fondoDe(get().fondos, conversacionId);
    const fondos = conFondo(get().fondos, conversacionId, fondo);
    set({ fondos });
    if (anterior.tipo === 'foto' && !(fondo.tipo === 'foto' && fondo.uri === anterior.uri)) {
      borrarCopia(anterior.uri);
    }
    await guardar(fondos);
  },

  async elegirFoto(conversacionId, uri) {
    if (!FONDO_CON_FOTO || !uri || !conversacionId) return false;
    let copia: string;
    try {
      copia = copiarFoto(uri);
    } catch {
      return false;
    }
    await get().elegir(conversacionId, { tipo: 'foto', uri: copia });
    return true;
  },
}));
