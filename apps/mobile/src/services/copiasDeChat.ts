/**
 * Lo que este teléfono YA TIENE de un chat, para no volver a pedirlo.
 *
 * Dos cosas, las dos en memoria y las dos indexadas por la ruta del archivo en
 * el almacén —que es lo único que no cambia: la dirección firmada caduca y es
 * distinta cada vez—:
 *
 *  1. EL ARCHIVO QUE SE ACABA DE ENVIAR. Quien manda una foto la tiene en el
 *     teléfono. Antes, en cuanto el servidor confirmaba el mensaje, la burbuja
 *     cambiaba la foto local por la del servidor y la descargaba entera: se
 *     veía cargar una foto que se acababa de mandar. Ahora se sigue pintando
 *     la que ya está aquí.
 *
 *  2. LA PORTADA DE UN VIDEO. Un fotograma, como imagen. Sin ella un video es
 *     un cuadro negro con un triángulo. Quien lo manda la genera y la sube
 *     junto al video; para los videos que no la traen —los anteriores a esto,
 *     o los mandados desde la web— se saca aquí del propio video, una vez, y
 *     el compresor la deja guardada con el nombre de la ruta.
 *
 * NADA DE ESTO SOBREVIVE AL CIERRE DE SESIÓN: ver `olvidarCopiasDeChat`.
 */
import { Image as ExpoImage } from 'expo-image';

import { nombreLocalDePortada } from '@/lib/mediosDeChat';
import { clearVideoPosters, createVideoPoster } from '@/services/mediaCompressor';

/** Cuántas rutas se recuerdan. Cada una son dos cadenas cortas. */
const TOPE = 300;

function recordar(mapa: Map<string, string>, ruta: string, uri: string): void {
  if (!ruta || !uri) return;
  mapa.delete(ruta);
  // El compresor a veces devuelve la ruta pelada (`/data/...`): quien pinta
  // imágenes necesita una dirección completa.
  mapa.set(ruta, uri.startsWith('/') ? `file://${uri}` : uri);
  // El más antiguo sale primero: un `Map` conserva el orden de entrada.
  while (mapa.size > TOPE) {
    const primera = mapa.keys().next().value;
    if (primera === undefined) break;
    mapa.delete(primera);
  }
}

const copias = new Map<string, string>();
const portadas = new Map<string, string>();
/** Videos de los que no se pudo sacar portada: no se insiste en cada repintado. */
const sinPortada = new Set<string>();

/** Anota dónde está, en este teléfono, el archivo que se acaba de subir. */
export function recordarCopia(ruta: string, uriLocal: string): void {
  recordar(copias, ruta, uriLocal);
}

/** El archivo local de esa ruta, si se subió desde aquí en esta sesión. */
export function copiaDe(ruta: string | null | undefined): string | undefined {
  return ruta ? copias.get(ruta) : undefined;
}

/**
 * La copia dejó de servir: el sistema limpia la carpeta temporal cuando
 * quiere. Se olvida, y quien la pintaba pasa a pedir la del servidor.
 */
export function descartarCopia(ruta: string): void {
  copias.delete(ruta);
}

export function recordarPortada(rutaDelVideo: string, uriLocal: string): void {
  recordar(portadas, rutaDelVideo, uriLocal);
}

export function portadaGuardada(rutaDelVideo: string | null | undefined): string | undefined {
  return rutaDelVideo ? portadas.get(rutaDelVideo) : undefined;
}

export function descartarPortada(rutaDelVideo: string): void {
  portadas.delete(rutaDelVideo);
}

// ---------------------------------------------------------------------------
// Sacar la portada del propio video
// ---------------------------------------------------------------------------

/** Cuántos videos se abren a la vez para sacarles el fotograma. */
const A_LA_VEZ = 2;
let enMarcha = 0;
const cola: (() => void)[] = [];
const enVuelo = new Map<string, Promise<string | null>>();

function turno(): Promise<void> {
  if (enMarcha < A_LA_VEZ) {
    enMarcha += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => cola.push(resolve));
}

function soltar(): void {
  const siguiente = cola.shift();
  // El turno pasa directamente al siguiente: `enMarcha` no baja ni sube.
  if (siguiente) siguiente();
  else enMarcha -= 1;
}

/**
 * Saca un fotograma del video y devuelve dónde quedó, o `null` si no se pudo.
 *
 * `origen` es la dirección del video: la firmada del servidor o la ruta local
 * de uno que todavía se está enviando.
 *
 * DE DOS EN DOS, y cada video una sola vez: abrir un chat con diez videos no
 * puede lanzar diez lecturas a la vez, y dos burbujas del mismo video —la del
 * chat y la de «Media»— comparten el resultado.
 *
 * NUNCA LANZA. Un video del que no sale portada se queda con su cuadro
 * oscuro, que es lo que había antes.
 */
export function generarPortada(rutaDelVideo: string, origen: string): Promise<string | null> {
  if (!rutaDelVideo || !origen) return Promise.resolve(null);
  const guardada = portadas.get(rutaDelVideo);
  if (guardada) return Promise.resolve(guardada);
  if (sinPortada.has(rutaDelVideo)) return Promise.resolve(null);

  const pendiente = enVuelo.get(rutaDelVideo);
  if (pendiente) return pendiente;

  const trabajo = (async (): Promise<string | null> => {
    await turno();
    try {
      const portada = await createVideoPoster(origen, nombreLocalDePortada(rutaDelVideo));
      if (!portada?.uri) {
        sinPortada.add(rutaDelVideo);
        return null;
      }
      recordarPortada(rutaDelVideo, portada.uri);
      return portada.uri;
    } catch {
      sinPortada.add(rutaDelVideo);
      return null;
    } finally {
      soltar();
      enVuelo.delete(rutaDelVideo);
    }
  })();
  enVuelo.set(rutaDelVideo, trabajo);
  return trabajo;
}

/**
 * Al cerrar sesión: lo que se sabía de los archivos de una cuenta no es de la
 * siguiente que entre en este teléfono.
 */
export function olvidarCopiasDeChat(): void {
  copias.clear();
  portadas.clear();
  sinPortada.clear();
  /*
    Y LO QUE QUEDÓ EN EL DISCO. Las fotos del chat se guardan con su ruta
    como clave para no volver a bajarlas, y las portadas de los videos, en
    la carpeta del compresor: son contenido privado de la cuenta que se va.
    Se lleva también las imágenes del muro, y no importa: sus direcciones
    firmadas ya se olvidan en este mismo cierre, así que se iban a volver a
    bajar de todos modos.
  */
  void ExpoImage.clearMemoryCache().catch(() => {});
  void ExpoImage.clearDiskCache().catch(() => {});
  void clearVideoPosters();
}
