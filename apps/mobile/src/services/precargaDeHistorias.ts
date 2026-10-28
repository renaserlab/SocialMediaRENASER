import { Platform } from 'react-native';
import { Image as ExpoImage } from 'expo-image';

import { crearColaDePrecarga, type Precarga } from '@/lib/cargaDeHistorias';

/**
 * Calienta las fotos de las historias para que el visor las encuentre YA en
 * la cache. Que se precarga, cuanto y en que orden lo decide
 * `lib/cargaDeHistorias.ts`; aqui solo se descarga.
 *
 * =============================================================================
 * POR QUE NO `Image.prefetch` EN EL MOVIL (y por que SI en la web)
 * =============================================================================
 * El visor pinta la foto con `cacheKey` = ruta de Storage, porque la firma
 * cambia en cada emision y, sin clave, cada refirma volveria a bajarla. Una
 * precarga solo sirve si guarda la imagen BAJO ESA MISMA CLAVE. Leido en
 * expo-image 3.0.11 (`node_modules/expo-image`):
 *
 *  - ANDROID (Glide). `prefetch` construye `GlideUrl(url)`: la cache de disco
 *    de datos queda indexada por la URL firmada. La vista, con `cacheKey`, usa
 *    `GlideUrlWithCustomCacheKey`, cuyo `getCacheKey()` devuelve la ruta. Dos
 *    claves distintas: la vista no encuentra lo precargado y lo baja otra vez.
 *    `loadAsync` en cambio recibe la fuente entera (`SourceMap`) y crea el
 *    mismo `GlideUrlWithCustomCacheKey`; con la estrategia por defecto de
 *    Glide, lo remoto se guarda en la cache de DATOS (los bytes originales)
 *    bajo esa clave, sea cual sea el tamaño al que se decodifique. Por eso se
 *    le pide una decodificacion diminuta: se guarda el original entero, que es
 *    lo que lee la vista, sin ocupar memoria con un mapa de bits que nadie
 *    pinta.
 *
 *  - iOS (SDWebImage). `prefetch` usa `SDWebImagePrefetcher` sin
 *    `cacheKeyFilter`: guarda bajo la URL firmada. `loadAsync` pasa por
 *    `createSDWebImageContext`, que SI pone el filtro con nuestro `cacheKey`, y
 *    usa la cache de disco, igual que la vista por defecto. Misma clave. Aqui
 *    NO se le pasan medidas: en iOS cualquier `maxWidth`/`maxHeight` activa la
 *    miniatura de SDWebImage, que añade un sufijo a la clave completa; sin
 *    ellas la clave es exactamente la ruta. La imagen decodificada que devuelve
 *    se suelta en cuanto llega (`release()`), para no esperar al recolector.
 *
 *  - WEB. expo-image IGNORA `cacheKey`: pinta un `<img src=URL>` sin
 *    `crossOrigin`, asi que la unica cache es la del navegador, por URL. Vale
 *    porque el visor usa LA MISMA URL firmada: sale del mismo almacen, y
 *    `signMediaUrls` reutiliza la firma mientras sigue vigente. Medido en
 *    Chrome (28/10/2026): tras `prefetch` —que en web es un `new Image()`— el
 *    `<img>` se pinta en 0 ms desde la cache de imagenes del documento; tras
 *    `loadAsync` —un `fetch()` a un `blob:`— tambien hay una sola descarga,
 *    pero solo porque Storage manda `Cache-Control: max-age`, y ademas
 *    decodifica una copia que nadie pinta. Por eso en web, `prefetch`.
 *
 * `cachePerfil.ts` ya usaba `loadAsync` con clave para las miniaturas de la
 * galeria, por lo mismo; aqui se añade el caso de la web y se suelta la
 * referencia.
 *
 * =============================================================================
 * UNA DESCARGA, NO DOS
 * =============================================================================
 * En Android, si el visor pinta una foto cuya precarga aun esta bajando, Glide
 * NO junta las dos peticiones (las agrupa por clave de motor, que incluye el
 * tamaño, y no coincide): la misma foto viajaria dos veces y llegaria mas
 * tarde que sin precarga. Por eso el visor pregunta `precargaEnCurso` y, si la
 * hay, espera a que termine y la pinta desde la cache. Y mientras espera su
 * foto, PAUSA la cola (`pausarPrecargas`): nada nuevo le quita ancho de banda.
 */

/**
 * Lado de la decodificacion en Android. Glide guarda los bytes originales
 * antes de decodificar, asi que esto solo decide cuanta memoria ocupa el mapa
 * de bits de la precarga: una foto de camara sin comprimir (las subidas desde
 * la web no se comprimen) son ~48 MB decodificada a tamaño real.
 */
const LADO_DE_DECODIFICACION_ANDROID = 64;

async function calentar({ uri, cacheKey }: Precarga): Promise<void> {
  if (Platform.OS === 'web') {
    // `prefetch` en web resuelve `false` en vez de fallar: se convierte en
    // error para que la cola la olvide y se pueda volver a pedir.
    if (!(await ExpoImage.prefetch(uri))) throw new Error('precarga fallida');
    return;
  }
  const opciones =
    Platform.OS === 'android'
      ? { maxWidth: LADO_DE_DECODIFICACION_ANDROID, maxHeight: LADO_DE_DECODIFICACION_ANDROID }
      : undefined;
  const imagen = await ExpoImage.loadAsync({ uri, cacheKey }, opciones);
  imagen.release();
}

/** Una sola cola para toda la aplicacion: la fila y el visor comparten tope. */
const cola = crearColaDePrecarga(calentar);

/**
 * Pide calentar estas fotos. No devuelve nada ni falla hacia fuera: es una
 * comodidad, no un paso del que dependa nada; si algo falla, el visor la pide
 * por su cuenta al pintarla.
 */
export function precargarHistorias(
  lista: readonly Precarga[],
  opciones?: { delante?: boolean },
): void {
  if (lista.length === 0) return;
  cola.pedir(lista, opciones);
}

/** Para el visor mientras espera su foto. Devuelve con que soltar la pausa. */
export function pausarPrecargas(): () => void {
  return cola.pausar();
}

/** La precarga de esa ruta si esta bajando ahora; se resuelve al terminar. */
export function precargaEnCurso(cacheKey: string): Promise<void> | undefined {
  return cola.enCurso(cacheKey);
}
