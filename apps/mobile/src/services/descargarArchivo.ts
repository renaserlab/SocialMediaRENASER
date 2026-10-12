/**
 * Descargar al teléfono un archivo del chat, SIN SALIR de la aplicación.
 *
 * LO QUE HABÍA (visto en teléfono el 12/10/2026): tocar un archivo abría su
 * dirección en el navegador. La persona acababa en una pestaña de Chrome con
 * una dirección del almacén, fuera de Z, y sin el archivo guardado en ningún
 * sitio.
 *
 * AHORA se baja a la carpeta temporal de la aplicación y de ahí va a donde
 * corresponde:
 *
 *  - UNA FOTO O UN VIDEO —aunque se mandaran como «Archivo»—, a la galería.
 *  - TODO LO DEMÁS, a una carpeta del teléfono. Android no deja que una
 *    aplicación escriba donde quiera: la persona elige la carpeta UNA vez y
 *    desde entonces las descargas van ahí sin preguntar. En iPhone no existe
 *    ese permiso: se abre la hoja del sistema, que ofrece «Guardar en Archivos».
 *
 * NUNCA LANZA. Lo que pasa vuelve como resultado y la pantalla lo dice.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { Linking, Platform, Share } from 'react-native';

import {
  cabeEnLaCarpeta,
  destinoDeDescarga,
  medioQueEs,
  nombreDeCarpetaElegida,
  nombreParaGuardar,
} from '@/lib/mediosDeChat';
import { enlaceDeDescarga, tipoDeContenidoDe } from '@/lib/tiposDeArchivo';

export type ResultadoDeDescarga =
  | { estado: 'guardado'; donde: 'galeria' }
  | { estado: 'guardado'; donde: 'carpeta'; carpeta: string }
  /** iPhone: se abrió la hoja del sistema para elegir dónde guardarlo. */
  | { estado: 'compartido' }
  /** Web: el navegador se encarga de la descarga. */
  | { estado: 'abierto_fuera' }
  | { estado: 'sin_permiso' }
  | { estado: 'cancelado' }
  | { estado: 'demasiado_grande' }
  | { estado: 'fallo' };

export type PedidoDeDescarga = {
  /** La dirección firmada del archivo. */
  url: string;
  nombre: string | null | undefined;
  mimeType: string | null | undefined;
  bytes?: number | null;
  /** De 0 a 1, mientras baja. */
  alAvanzar?: (ratio: number) => void;
};

/** Dónde se recuerda la carpeta elegida. Es de este teléfono, no de la cuenta. */
const CLAVE_DE_CARPETA = 'z.descargas.carpeta.v1';

/**
 * Por dónde empieza el selector de carpetas: «Documentos». La carpeta
 * «Descargas» no se puede conceder entera a una aplicación desde Android 11,
 * y abrir el selector ahí dejaría el botón de aceptar apagado.
 */
const CARPETA_INICIAL =
  'content://com.android.externalstorage.documents/document/primary%3ADocuments';

/** La carpeta ya elegida, si sigue existiendo y con permiso. */
async function carpetaGuardada(): Promise<Directory | null> {
  try {
    const uri = await AsyncStorage.getItem(CLAVE_DE_CARPETA);
    if (!uri) return null;
    const carpeta = new Directory(uri);
    if (carpeta.exists) return carpeta;
  } catch {
    // Se trata como si no hubiera ninguna.
  }
  await AsyncStorage.removeItem(CLAVE_DE_CARPETA).catch(() => {});
  return null;
}

async function elegirCarpeta(): Promise<Directory | null> {
  try {
    const elegida = await Directory.pickDirectoryAsync(CARPETA_INICIAL);
    await AsyncStorage.setItem(CLAVE_DE_CARPETA, elegida.uri).catch(() => {});
    return new Directory(elegida.uri);
  } catch {
    // Cerrar el selector sin elegir lanza: es «canceló», no un error.
    return null;
  }
}

/**
 * Si la próxima descarga de este archivo va a abrir el selector de carpetas.
 *
 * Es para que la pantalla lo EXPLIQUE antes: un selector de carpetas del
 * sistema que aparece sin aviso al tocar «descargar» parece un error.
 */
export async function hayQueElegirCarpeta(
  mimeType: string | null | undefined,
  nombre: string | null | undefined,
): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  if (destinoDeDescarga(mimeType, nombre) !== 'carpeta') return false;
  return (await carpetaGuardada()) === null;
}

/** Baja el archivo a la carpeta temporal y devuelve dónde quedó. */
async function bajar(
  url: string,
  nombre: string,
  alAvanzar?: (ratio: number) => void,
): Promise<string | null> {
  const legacy = await import('expo-file-system/legacy');
  const base = legacy.cacheDirectory;
  if (!base) return null;
  // Una carpeta por descarga: el archivo conserva SU nombre —es con el que la
  // galería lo guarda— sin pisar otro que se llame igual.
  const carpeta = `${base}z-descargas/${Date.now()}-${Math.round(Math.random() * 1e6)}/`;
  await legacy.makeDirectoryAsync(carpeta, { intermediates: true });
  // Codificado: un nombre con espacios, «#» o «?» partiría la dirección.
  const destino = `${carpeta}${encodeURIComponent(nombre)}`;
  const tarea = legacy.createDownloadResumable(url, destino, {}, (avance) => {
    const total = avance.totalBytesExpectedToWrite;
    if (total > 0) alAvanzar?.(Math.min(1, avance.totalBytesWritten / total));
  });
  const bajado = await tarea.downloadAsync();
  if (!bajado || bajado.status < 200 || bajado.status >= 300) return null;
  return bajado.uri;
}

async function borrar(uri: string | null): Promise<void> {
  if (!uri) return;
  const legacy = await import('expo-file-system/legacy');
  // La copia temporal ya no hace falta; si no se puede borrar, no pasa nada.
  await legacy.deleteAsync(uri, { idempotent: true }).catch(() => {});
}

export async function descargarAlTelefono(
  pedido: PedidoDeDescarga,
): Promise<ResultadoDeDescarga> {
  const { url, mimeType, bytes, alAvanzar } = pedido;
  let temporal: string | null = null;
  try {
    if (Platform.OS === 'web') {
      await Linking.openURL(enlaceDeDescarga(url, pedido.nombre));
      return { estado: 'abierto_fuera' };
    }

    const medio = medioQueEs(mimeType, pedido.nombre);
    const nombre = nombreParaGuardar(
      pedido.nombre,
      medio === 'image' ? 'jpg' : medio === 'video' ? 'mp4' : 'bin',
    );

    // --- Una foto o un video: a la galería -------------------------------
    if (destinoDeDescarga(mimeType, pedido.nombre) === 'galeria') {
      // Solo permiso de ESCRIBIR: para guardar no hace falta leer la galería.
      const permiso = await MediaLibrary.requestPermissionsAsync(true);
      if (!permiso.granted) return { estado: 'sin_permiso' };
      temporal = await bajar(url, nombre, alAvanzar);
      if (!temporal) return { estado: 'fallo' };
      await MediaLibrary.saveToLibraryAsync(temporal);
      return { estado: 'guardado', donde: 'galeria' };
    }

    // --- Lo demás, en iPhone: la hoja del sistema ------------------------
    if (Platform.OS !== 'android') {
      temporal = await bajar(url, nombre, alAvanzar);
      if (!temporal) return { estado: 'fallo' };
      const compartir = temporal;
      // No se borra: la hoja lo lee después de que esta función vuelva. Vive en
      // la carpeta temporal, que el sistema limpia solo.
      temporal = null;
      await Share.share({ url: compartir });
      return { estado: 'compartido' };
    }

    // --- Lo demás, en Android: a la carpeta elegida ----------------------
    if (!cabeEnLaCarpeta(bytes)) return { estado: 'demasiado_grande' };
    // La carpeta ANTES de bajar nada: si la persona cierra el selector, no se
    // le ha hecho esperar una descarga para nada.
    let carpeta = (await carpetaGuardada()) ?? (await elegirCarpeta());
    if (!carpeta) return { estado: 'cancelado' };

    temporal = await bajar(url, nombre, alAvanzar);
    if (!temporal) return { estado: 'fallo' };
    const contenido = await new File(temporal).bytes();
    if (!cabeEnLaCarpeta(contenido.byteLength)) return { estado: 'demasiado_grande' };

    const tipo = tipoDeContenidoDe(mimeType, nombre);
    const escribir = (destino: Directory) => {
      destino.createFile(nombre, tipo).write(contenido);
    };
    try {
      escribir(carpeta);
    } catch {
      // La carpeta ya no vale (la borraron, o se retiró el permiso desde los
      // ajustes del sistema): se pregunta otra vez, una sola.
      await AsyncStorage.removeItem(CLAVE_DE_CARPETA).catch(() => {});
      carpeta = await elegirCarpeta();
      if (!carpeta) return { estado: 'cancelado' };
      escribir(carpeta);
    }
    return { estado: 'guardado', donde: 'carpeta', carpeta: nombreDeCarpetaElegida(carpeta.uri) };
  } catch {
    return { estado: 'fallo' };
  } finally {
    await borrar(temporal);
  }
}
