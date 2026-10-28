import {
  BYTES_DE_CABECERA,
  CALIDAD_JPEG,
  cabeEnMemoria,
  convieneLaReducida,
  esFotoReducible,
  hayQueReducir,
  leerCabeceraJpeg,
  medidasOrientadas,
  medidasReducidas,
  orientacionRespetada,
  pasosDeEscalado,
  type Medidas,
} from '@/lib/reduccionDeFoto';
import type { PickedMedia, UploadProgress } from '@/services/storage';

/** Lo que hay que subir, y como soltar la copia si se hizo una. */
export type FotoParaSubir = {
  /** La foto reducida, o el mismo medio que llego si no se toco. */
  media: PickedMedia;
  /** Libera la copia reducida. Se llama al terminar de subir, haya ido bien o mal. */
  liberar: () => void;
};

const sinTocar = (media: PickedMedia): FotoParaSubir => ({ media, liberar: () => {} });

/**
 * Web: reduce la foto a lo mismo que sube la aplicacion instalada (1280 px,
 * JPEG 0,8) antes de que salga del navegador.
 *
 * En la web no hay `react-native-compressor` y la foto de la camara viajaba
 * entera, de 3 a 6 MB, y asi la descargaba despues cada espectador de la
 * historia (ver `lib/reduccionDeFoto.ts`). El navegador ya trae lo necesario
 * para encogerla: decodificar (`createImageBitmap`), escalar y volver a
 * codificar (un lienzo). Nada que instalar.
 *
 * NUNCA DEJA A NADIE SIN SUBIR. Ante cualquier duda —no es JPEG, el navegador no
 * la sabe abrir (HEIC en Chrome), no hay memoria para decodificarla, no se
 * puede comprobar que salio derecha, o la reducida no ahorra lo bastante— se
 * devuelve el medio tal cual y se sube el original, que es exactamente lo que
 * pasaba antes. Esta funcion no lanza.
 *
 * LA RUTA Y EL TIPO NO CAMBIAN. Solo se tocan JPEG y la salida es JPEG, asi
 * que el nombre y el tipo del original siguen valiendo: `uploadPostMedia` le
 * pone la misma extension y el mismo `contentType` que le habria puesto al
 * original. Cambian la `uri` (una copia en memoria) y las medidas.
 */
export async function prepararFotoParaSubir(
  media: PickedMedia,
  onProgress?: (progress: UploadProgress) => void,
): Promise<FotoParaSubir> {
  if (media.kind !== 'image' || !esFotoReducible(media.mimeType, media.name)) {
    return sinTocar(media);
  }
  try {
    const reducida = await reducir(media, onProgress);
    if (!reducida) return sinTocar(media);
    const uri = URL.createObjectURL(reducida.blob);
    return {
      media: { ...media, uri, width: reducida.ancho, height: reducida.alto },
      liberar: () => URL.revokeObjectURL(uri),
    };
  } catch {
    // Formato que el navegador no abre, falta de memoria, un navegador que no
    // entiende `imageOrientation`... Se sube el original, como siempre.
    return sinTocar(media);
  }
}

async function reducir(
  media: PickedMedia,
  onProgress?: (progress: UploadProgress) => void,
): Promise<(Medidas & { blob: Blob }) | null> {
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return null;

  const respuesta = await fetch(media.uri);
  if (!respuesta.ok) return null;
  const original = await respuesta.blob();

  // Con las medidas del selector ya se sabe si es pequena, sin abrirla.
  if (!hayQueReducir({ ancho: media.width, alto: media.height, bytes: original.size })) {
    return null;
  }

  /*
    La cabecera dice el tipo de verdad (un archivo mal etiquetado no pasa), las
    medidas y la orientacion EXIF. Con ella se comprueba despues que el
    navegador giro la foto: sin cabecera legible no hay comprobacion posible y
    se sube el original.
  */
  const cabecera = leerCabeceraJpeg(
    new Uint8Array(await original.slice(0, BYTES_DE_CABECERA).arrayBuffer()),
  );
  if (!cabecera) return null;
  const origen = medidasOrientadas(cabecera);
  if (!hayQueReducir({ ...origen, bytes: original.size })) return null;
  if (!cabeEnMemoria(origen)) return null;

  // La misma fase que muestra la aplicacion instalada mientras comprime.
  onProgress?.({ phase: 'compressing', ratio: 0 });

  /*
    `from-image`: que el navegador aplique el giro del EXIF al decodificar. El
    lienzo no guarda EXIF, asi que lo que se pinta es lo que se vera siempre. Un
    navegador que no conozca el valor lo rechaza con un error y se sube el
    original. Y por si alguno lo aceptara sin hacerle caso, se comprueban las
    medidas antes de seguir.
  */
  const bitmap = await createImageBitmap(original, { imageOrientation: 'from-image' });
  let salida: Blob | null;
  const destino = medidasReducidas(origen);
  try {
    if (!orientacionRespetada(cabecera, { ancho: bitmap.width, alto: bitmap.height })) {
      return null;
    }
    salida = await escalarYCodificar(bitmap, origen, destino);
  } finally {
    // Una foto de 12 MP decodificada son ~48 MB: se sueltan en cuanto se pintan.
    bitmap.close();
  }

  if (!salida || !convieneLaReducida(original.size, salida.size)) return null;
  onProgress?.({ phase: 'compressing', ratio: 1 });
  return { blob: salida, ...destino };
}

/** Pinta la foto en `destino` bajando por mitades y la codifica en JPEG. */
async function escalarYCodificar(
  bitmap: ImageBitmap,
  origen: Medidas,
  destino: Medidas,
): Promise<Blob | null> {
  let fuente: CanvasImageSource = bitmap;
  let lienzo: HTMLCanvasElement | null = null;
  try {
    for (const paso of pasosDeEscalado(origen, destino)) {
      const siguiente = document.createElement('canvas');
      siguiente.width = paso.ancho;
      siguiente.height = paso.alto;
      const ctx = siguiente.getContext('2d');
      if (!ctx) return null;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(fuente, 0, 0, paso.ancho, paso.alto);
      if (lienzo) vaciar(lienzo);
      lienzo = siguiente;
      fuente = siguiente;
    }
    const final = lienzo;
    if (!final) return null;
    return await new Promise<Blob | null>((resolve) =>
      final.toBlob(resolve, 'image/jpeg', CALIDAD_JPEG),
    );
  } finally {
    if (lienzo) vaciar(lienzo);
  }
}

/**
 * Suelta la memoria de un lienzo ya usado. Safari la retiene hasta que pasa el
 * recolector, y en un iPhone el total de lienzos tiene tope: dejar dos
 * intermedios de varios megapixeles vivos puede hacer fallar el siguiente.
 */
function vaciar(lienzo: HTMLCanvasElement): void {
  lienzo.width = 0;
  lienzo.height = 0;
}
