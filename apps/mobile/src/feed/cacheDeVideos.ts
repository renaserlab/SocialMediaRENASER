import AsyncStorage from '@react-native-async-storage/async-storage';

import type { ReelItem } from '@/components/ShortVideoItem';

/**
 * Instantanea del Inicio, para que abrir la aplicacion sin cobertura no sea
 * una pantalla negra.
 *
 * POR QUE. El Inicio es ahora lo PRIMERO que se ve. Si la peticion falla —red
 * caida, servidor despertando, tunel, avion— lo unico que quedaba era un
 * mensaje de error sobre fondo negro, y la aplicacion parecia rota cuando lo
 * que estaba mal era la conexion.
 *
 * QUE DA Y QUE NO DA, sin adornos:
 *  - SI: se ven las portadas, quien publica y los textos, y se puede recorrer
 *    la lista. Las portadas salen del disco (`posterPath` es una clave de cache
 *    estable), asi que aparecen aunque no haya red.
 *  - NO: los videos no se reproducen sin conexion. Sus direcciones van firmadas
 *    y caducan, y ademas los bytes no estan descargados. Por eso la pantalla lo
 *    DICE en lugar de dejar que alguien toque y no pase nada.
 *
 * Solo se guarda "Para ti": es lo que se abre por defecto. "Siguiendo" depende
 * de a quien sigue cada quien y guardarlo tambien duplicaria el espacio para
 * algo que se visita mucho menos.
 */

const CLAVE = 'z.inicio.instantanea.v1';

/**
 * Cuantos se guardan.
 *
 * Doce es alrededor de dos paginas: suficiente para que se note que hay
 * contenido y para leer un rato, y poco para que escribirlo en disco no
 * compita con la primera peticion en el arranque.
 */
const MAXIMO = 12;

type Instantanea = {
  guardadaEn: number;
  items: ReelItem[];
};

/**
 * Cuanto vale una instantanea.
 *
 * Tres dias. Pasado ese tiempo lo guardado ya no representa lo que hay, y es
 * preferible decir «no pudimos cargar» que ensenar un muro de la semana pasada
 * como si fuera de ahora.
 */
const CADUCIDAD_MS = 3 * 24 * 60 * 60 * 1000;

export async function guardarInstantaneaDeVideos(items: ReelItem[]): Promise<void> {
  if (items.length === 0) return;
  try {
    const instantanea: Instantanea = {
      guardadaEn: Date.now(),
      items: items.slice(0, MAXIMO),
    };
    await AsyncStorage.setItem(CLAVE, JSON.stringify(instantanea));
  } catch {
    // Guardar es una comodidad: si el disco no deja, no pasa nada.
  }
}

export async function leerInstantaneaDeVideos(): Promise<ReelItem[]> {
  try {
    const crudo = await AsyncStorage.getItem(CLAVE);
    if (!crudo) return [];
    const instantanea = JSON.parse(crudo) as Instantanea;
    if (!Array.isArray(instantanea?.items) || instantanea.items.length === 0) return [];
    if (Date.now() - (instantanea.guardadaEn ?? 0) > CADUCIDAD_MS) return [];
    return instantanea.items;
  } catch {
    // Instantanea corrupta o ilegible: la carga de red sigue su curso.
    return [];
  }
}

/** Se vacia al cerrar sesion: el contenido guardado es de quien lo vio. */
export async function olvidarInstantaneaDeVideos(): Promise<void> {
  try {
    await AsyncStorage.removeItem(CLAVE);
  } catch {
    // Nada que hacer; el contenido caduca solo.
  }
}
