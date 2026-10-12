import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { create } from 'zustand';

import {
  CLAVE_DE_FONDO,
  FONDO_POR_DEFECTO,
  escribirFondo,
  leerFondo,
  type FondoDeChat,
} from '@/lib/fondoDeChat';

/**
 * El fondo del chat que esta persona eligió EN ESTE TELÉFONO.
 *
 * No viaja al servidor: es cómo quiere ver sus chats aquí, y nadie más lo ve.
 * Se lee del disco una vez por sesión y se guarda al cambiarlo.
 *
 * UNA FOTO SE COPIA A LA CARPETA DE LA APLICACIÓN. El selector entrega una
 * ruta de la caché, que el sistema puede vaciar cuando quiera: guardar esa
 * ruta dejaría el chat sin fondo cualquier día. Se guarda la copia, y la
 * anterior se borra al cambiarla.
 */
type Estado = {
  fondo: FondoDeChat;
  /** Ya se ha leído lo guardado: hasta entonces se pinta el fondo de siempre. */
  leido: boolean;
  leer: () => Promise<void>;
  elegir: (fondo: FondoDeChat) => Promise<void>;
  /** Pone como fondo una foto recién elegida. Devuelve `false` si no se pudo. */
  elegirFoto: (uri: string) => Promise<boolean>;
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

async function guardar(fondo: FondoDeChat): Promise<void> {
  try {
    await AsyncStorage.setItem(CLAVE_DE_FONDO, escribirFondo(fondo));
  } catch {
    // Sin disco, el fondo vale hasta cerrar la aplicación. Se ve igual.
  }
}

export const useFondoDeChatStore = create<Estado>((set, get) => ({
  fondo: FONDO_POR_DEFECTO,
  leido: false,

  async leer() {
    if (get().leido) return;
    let fondo = FONDO_POR_DEFECTO;
    try {
      fondo = leerFondo(await AsyncStorage.getItem(CLAVE_DE_FONDO));
    } catch {
      // Lo que no se puede leer es «por defecto».
    }
    // Una foto guardada donde no se pueden usar fotos no se intenta pintar.
    if (fondo.tipo === 'foto' && !FONDO_CON_FOTO) fondo = FONDO_POR_DEFECTO;
    // Si mientras se leía ya se eligió otro, manda el elegido.
    if (!get().leido) set({ fondo, leido: true });
  },

  async elegir(fondo) {
    const anterior = get().fondo;
    set({ fondo, leido: true });
    if (anterior.tipo === 'foto' && !(fondo.tipo === 'foto' && fondo.uri === anterior.uri)) {
      borrarCopia(anterior.uri);
    }
    await guardar(fondo);
  },

  async elegirFoto(uri) {
    if (!FONDO_CON_FOTO || !uri) return false;
    let copia: string;
    try {
      copia = copiarFoto(uri);
    } catch {
      return false;
    }
    await get().elegir({ tipo: 'foto', uri: copia });
    return true;
  },
}));
