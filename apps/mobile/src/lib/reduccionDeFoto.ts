/**
 * QUE UNA FOTO DE HISTORIA SUBIDA DESDE LA WEB NO PESE LO QUE PESA EL ORIGINAL.
 *
 * Auditoria del 28/10/2026, §11, punto 3. Las historias no pasan por el proceso
 * de derivados del servidor (solo trabaja con `post_media`), asi que cada
 * espectador descarga EXACTAMENTE lo que se subio. Desde la aplicacion
 * instalada eso es poco: `react-native-compressor` deja la foto en 1280 px. Desde
 * la web no hay compresor y viajaba el original de la camara, de 3 a 6 MB, que
 * cada espectador bajaba entero antes de ver nada.
 *
 * La reduccion en si (decodificar, escalar, codificar) vive en
 * `services/reducirFoto.web.ts`, que es quien toca el navegador. Aqui esta lo que
 * se decide SIN navegador, para poder probarlo con `node --test`:
 *
 *  1. SI se toca la foto (`esFotoReducible`, `hayQueReducir`, `cabeEnMemoria`,
 *     `convieneLaReducida`).
 *  2. A QUE MEDIDA y en cuantos pasos (`medidasReducidas`, `pasosDeEscalado`).
 *  3. Si el navegador la ha GIRADO como dice su EXIF (`leerCabeceraJpeg`,
 *     `medidasOrientadas`, `orientacionRespetada`). Es la red que impide que una
 *     foto vertical de movil acabe tumbada.
 */

/**
 * Lado mayor de la foto que se sube, en pixeles.
 *
 * NO ES UN NUMERO NUEVO: es el que ya aplica la aplicacion instalada. Alli se
 * llama a `Image.compress(uri, { compressionMethod: 'auto' })` sin mas
 * opciones, y el modo `auto` de `react-native-compressor` 1.19 escala al lado
 * mayor de 1280 px (`maxWidth`/`maxHeight` por defecto, Android e iOS). Una
 * historia ocupa la pantalla de un movil, que rara vez pasa de 1290 px de
 * ancho fisico, y se ve unos segundos: por encima de esto son bytes que nadie
 * llega a ver. Si algun dia cambia alli, tiene que cambiar aqui.
 */
export const LADO_MAXIMO_PX = 1280;

/** Calidad JPEG de salida: la misma 0,8 del compresor nativo en modo `auto`. */
export const CALIDAD_JPEG = 0.8;

/**
 * Por debajo de este peso, una foto que ya cabe en `LADO_MAXIMO_PX` se sube tal
 * cual.
 *
 * Lo que sale de reducir una foto a 1280 px y calidad 0,8 pesa entre 30 y 260
 * KB (medido el 28/10/2026 en Chrome con fotos de 3–6 MB, de 4000x3000 y
 * 3840x2160). Una que ya cabe y pesa menos de medio mega esta en ese orden:
 * recodificarla ahorraria poco y le sumaria una segunda perdida de calidad. Por
 * encima —un JPEG a calidad 100, una foto con mucho grano— si compensa, aunque
 * no haya que encogerla.
 */
export const BYTES_SIN_REDUCIR = 500 * 1024;

/**
 * Lo minimo que tiene que ahorrar la version reducida para usarla.
 *
 * El compresor nativo descarta su resultado si no es mas pequeno que el
 * original. Aqui se pide algo mas, un 10 %: recodificar para ganar un 2 % es
 * empeorar la foto a cambio de nada.
 */
export const AHORRO_MINIMO = 0.1;

/** Cuanto del principio del archivo se lee para encontrar su cabecera. */
export const BYTES_DE_CABECERA = 512 * 1024;

/**
 * Pixeles a partir de los cuales no se intenta reducir.
 *
 * Para encoger una foto hay que decodificarla entera: 4 bytes por pixel. Una de
 * 12 MP, que es lo que guarda cualquier movil por defecto, son 48 MB y no es
 * problema. Una de 50 o 108 MP (el modo de resolucion completa de algunos
 * Android) son 200–430 MB de golpe, y en un telefono modesto el navegador puede
 * cerrar la pestana en mitad de la publicacion. Ahi se sube el original, como
 * hasta ahora: pesa, pero se publica.
 */
export const PIXELES_MAXIMOS = 25_000_000;

export type Medidas = { ancho: number; alto: number };

/**
 * Solo JPEG. Es una decision, no un olvido:
 *  - PNG, WebP y GIF pueden traer TRANSPARENCIA, que en JPEG se vuelve negro, o
 *    ANIMACION, de la que el lienzo solo pinta el primer fotograma.
 *  - HEIC solo lo sabe abrir Safari. En Chrome fallaria igual, y alli ya se sube
 *    el original como siempre.
 * Una foto de camara es JPEG, que es justo el caso que pesa 3–6 MB. El tipo se
 * confirma despues leyendo la cabecera: un archivo mal etiquetado no pasa.
 */
export function esFotoReducible(mimeType?: string | null, nombre?: string | null): boolean {
  const tipo = (mimeType ?? '').trim().toLowerCase();
  if (tipo) return tipo === 'image/jpeg' || tipo === 'image/jpg' || tipo === 'image/pjpeg';
  const extension = (nombre ?? '').split('.').pop()?.toLowerCase();
  return extension === 'jpg' || extension === 'jpeg';
}

const valida = (n: number | null | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * ¿Merece la pena tocar esta foto?
 *
 * Solo se deja como esta si YA es pequena en las dos cosas: medidas y peso. Sin
 * medidas fiables (el selector web informa 0 cuando no la pudo abrir) no se
 * puede saber, y se responde que si: quien llama la decodifica y vuelve a
 * preguntar con las medidas de verdad.
 */
export function hayQueReducir(foto: {
  ancho?: number | null;
  alto?: number | null;
  bytes: number;
}): boolean {
  if (!valida(foto.ancho) || !valida(foto.alto)) return true;
  const yaCabe = Math.max(foto.ancho, foto.alto) <= LADO_MAXIMO_PX;
  return !(yaCabe && foto.bytes <= BYTES_SIN_REDUCIR);
}

/** ¿Se puede decodificar sin arriesgar la memoria del telefono? Ver `PIXELES_MAXIMOS`. */
export function cabeEnMemoria(origen: Medidas): boolean {
  return origen.ancho * origen.alto <= PIXELES_MAXIMOS;
}

/**
 * Medidas de salida: el lado mayor a `ladoMaximo`, en proporcion.
 *
 * Nunca AMPLIA: una foto que ya cabe sale con sus mismas medidas (si se
 * recodifica es solo por peso, ver `hayQueReducir`).
 */
export function medidasReducidas(origen: Medidas, ladoMaximo = LADO_MAXIMO_PX): Medidas {
  const mayor = Math.max(origen.ancho, origen.alto);
  if (mayor <= ladoMaximo) return { ancho: origen.ancho, alto: origen.alto };
  const escala = ladoMaximo / mayor;
  return {
    ancho: Math.max(1, Math.round(origen.ancho * escala)),
    alto: Math.max(1, Math.round(origen.alto * escala)),
  };
}

/**
 * Las medidas intermedias para llegar de `origen` a `destino`, la ultima incluida.
 * Siempre hay al menos una, `destino`, aunque coincida con `origen`: es el
 * lienzo en el que se codifica.
 *
 * POR QUE NO DE UN SOLO SALTO. Pasar de 4000 a 1280 px de una vez es dividir
 * por mas de tres, y los navegadores que no hacen caso de
 * `imageSmoothingQuality` (Firefox) muestrean con un filtro bilineal que solo
 * mira 2x2 pixeles: se salta pixeles y la foto sale con dientes de sierra y
 * moire en las texturas finas. Bajando a la mitad mientras se pueda, cada paso
 * promedia todo lo que hay, y el ultimo ajusta a la medida exacta.
 */
export function pasosDeEscalado(origen: Medidas, destino: Medidas): Medidas[] {
  const pasos: Medidas[] = [];
  let actual = origen;
  while (actual.ancho / 2 >= destino.ancho && actual.alto / 2 >= destino.alto) {
    actual = { ancho: Math.round(actual.ancho / 2), alto: Math.round(actual.alto / 2) };
    pasos.push(actual);
  }
  const ultimo = pasos[pasos.length - 1];
  if (!ultimo || ultimo.ancho !== destino.ancho || ultimo.alto !== destino.alto) {
    pasos.push(destino);
  }
  return pasos;
}

/** ¿Compensa subir la reducida en vez del original? */
export function convieneLaReducida(bytesOriginal: number, bytesReducida: number): boolean {
  return bytesReducida > 0 && bytesReducida <= bytesOriginal * (1 - AHORRO_MINIMO);
}

// --------------------------------------------------------------------------
// Cabecera JPEG: medidas tal como estan guardadas y orientacion EXIF
// --------------------------------------------------------------------------

/**
 * Lo que dice la cabecera de un JPEG.
 *
 * `ancho` y `alto` son los de los pixeles TAL COMO ESTAN GUARDADOS. Un movil en
 * vertical guarda casi siempre la foto apaisada (4000x3000) y anota en el EXIF
 * que hay que girarla (`orientacion` 6 u 8). Quien la muestra la gira; quien la
 * pinta en un lienzo, solo si se lo piden.
 */
export type CabeceraJpeg = Medidas & {
  /** 1 a 8, segun EXIF. 1 si no hay EXIF o no dice nada. */
  orientacion: number;
};

/**
 * Lee medidas y orientacion EXIF de los primeros bytes de un JPEG.
 *
 * `null` si no es un JPEG o la cabecera no esta entera en lo leido. Quien llama
 * lo toma como «no se puede comprobar» y sube el original: aqui no se adivina.
 * Las medidas del marco SOF y la orientacion del EXIF siempre van antes de los
 * datos de imagen (SOS), asi que basta con el principio del archivo.
 */
export function leerCabeceraJpeg(bytes: Uint8Array): CabeceraJpeg | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let orientacion = 1;
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marcador = bytes[i + 1]!;
    // Relleno entre segmentos: 0xFF repetidos.
    if (marcador === 0xff) {
      i += 1;
      continue;
    }
    // Marcadores sueltos, sin longitud (TEM y RST0–RST7).
    if (marcador === 0x01 || (marcador >= 0xd0 && marcador <= 0xd7)) {
      i += 2;
      continue;
    }
    // Empiezan los datos de imagen sin haber visto las medidas: algo raro.
    if (marcador === 0xda || marcador === 0xd9) return null;
    const longitud = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (longitud < 2) return null;
    const inicio = i + 4;
    const fin = i + 2 + longitud;

    if (marcador === 0xe1 && fin <= bytes.length) {
      const leida = orientacionExif(bytes.subarray(inicio, fin));
      if (leida !== null) orientacion = leida;
    }
    // SOF0–SOF15 salvo DHT (C4), JPG (C8) y DAC (CC), que comparten rango.
    if (
      marcador >= 0xc0 &&
      marcador <= 0xcf &&
      marcador !== 0xc4 &&
      marcador !== 0xc8 &&
      marcador !== 0xcc
    ) {
      if (inicio + 5 > bytes.length) return null;
      const alto = (bytes[inicio + 1]! << 8) | bytes[inicio + 2]!;
      const ancho = (bytes[inicio + 3]! << 8) | bytes[inicio + 4]!;
      if (!ancho || !alto) return null;
      return { ancho, alto, orientacion };
    }
    i = fin;
  }
  return null;
}

/** Orientacion (etiqueta 0x0112 de IFD0) de un segmento APP1, o `null`. */
function orientacionExif(segmento: Uint8Array): number | null {
  // "Exif\0\0" y despues la cabecera TIFF.
  if (
    segmento.length < 14 ||
    segmento[0] !== 0x45 ||
    segmento[1] !== 0x78 ||
    segmento[2] !== 0x69 ||
    segmento[3] !== 0x66 ||
    segmento[4] !== 0 ||
    segmento[5] !== 0
  ) {
    return null;
  }
  const tiff = segmento.subarray(6);
  const vista = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const orden = vista.getUint16(0);
  if (orden !== 0x4949 && orden !== 0x4d4d) return null;
  const le = orden === 0x4949; // "II": Intel, little-endian. "MM": Motorola.
  if (vista.getUint16(2, le) !== 42) return null;
  const ifd0 = vista.getUint32(4, le);
  if (ifd0 + 2 > tiff.length) return null;
  const entradas = vista.getUint16(ifd0, le);
  for (let n = 0; n < entradas; n += 1) {
    const entrada = ifd0 + 2 + n * 12;
    if (entrada + 12 > tiff.length) return null;
    if (vista.getUint16(entrada, le) === 0x0112) {
      const valor = vista.getUint16(entrada + 8, le);
      return valor >= 1 && valor <= 8 ? valor : 1;
    }
  }
  return null;
}

/** Medidas como se VEN: con las orientaciones 5 a 8 el ancho y el alto se cruzan. */
export function medidasOrientadas(cabecera: CabeceraJpeg): Medidas {
  return cabecera.orientacion >= 5
    ? { ancho: cabecera.alto, alto: cabecera.ancho }
    : { ancho: cabecera.ancho, alto: cabecera.alto };
}

/**
 * ¿La foto decodificada salio girada como manda su EXIF?
 *
 * El lienzo no guarda EXIF: lo que se pinta es lo que se ve, para siempre. Si
 * el navegador NO aplico la orientacion, la foto vertical saldria tumbada en
 * todas partes. Con las orientaciones 5 a 8 eso se nota en las medidas (ancho y
 * alto cruzados) y aqui se detecta; entonces se sube el original, que se
 * seguira viendo bien como hasta ahora. Las 2 a 4 (espejo, 180°) no cambian las
 * medidas y no se pueden comprobar asi: para esas se confia en
 * `imageOrientation: 'from-image'`, que el navegador rechaza con un error si no
 * lo entiende.
 */
export function orientacionRespetada(cabecera: CabeceraJpeg, decodificada: Medidas): boolean {
  const esperadas = medidasOrientadas(cabecera);
  return decodificada.ancho === esperadas.ancho && decodificada.alto === esperadas.alto;
}
