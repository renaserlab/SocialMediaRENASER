/**
 * Las decisiones sobre las fotos, los videos y los archivos de un chat que no
 * dependen del teléfono: qué se achica antes de enviar, dónde vive la portada
 * de un video, cuándo una foto va sin marco, cómo se pinta un archivo y adónde
 * va a parar al descargarlo.
 *
 * POR QUÉ EXISTE (12/10/2026). Visto en teléfono: las fotos tardaban en
 * aparecer, un video salía como un cuadro negro y un archivo se abría en el
 * navegador. Las tres cosas tenían la misma raíz: el chat mandaba y pedía los
 * archivos tal cual, sin prepararlos. Lo que se decide aquí es esa preparación.
 *
 * Sin importaciones, a propósito: se prueba con `node --test` tal cual.
 */

export type TipoDeMedio = 'image' | 'video' | 'document' | 'audio';

// ---------------------------------------------------------------------------
// Antes de enviar
// ---------------------------------------------------------------------------

function extension(nombre: string | null | undefined): string {
  if (!nombre) return '';
  const limpio = nombre.split(/[?#]/)[0] ?? '';
  const punto = limpio.lastIndexOf('.');
  if (punto < 0 || punto === limpio.length - 1) return '';
  const ext = limpio.slice(punto + 1).toLowerCase();
  return /^[a-z0-9]{1,6}$/.test(ext) ? ext : '';
}

/** Imágenes que pueden moverse o llevar transparencia: comprimirlas las rompe. */
const SIN_COMPRIMIR = new Set(['gif', 'webp']);

/**
 * Si este archivo se achica en el teléfono antes de subirlo.
 *
 * UNA FOTO Y UN VIDEO, SÍ. La cámara de un teléfono da fotos de 3 a 8 MB y
 * videos de 100 MB por minuto; en un chat se ven en una burbuja de 250 puntos.
 * Achicados pesan diez veces menos, y eso es diez veces menos de espera para
 * quien manda y para cada persona que recibe.
 *
 * UN ARCHIVO, NUNCA. Quien entra por «Archivo» quiere que llegue el original,
 * byte a byte: un PDF, una hoja de cálculo, o una foto que mandó así justo
 * para que no pierda calidad.
 *
 * NI UN GIF NI UN WEBP: el compresor los convierte en un JPG quieto.
 */
export function seComprime(
  tipo: TipoDeMedio,
  mimeType: string | null | undefined,
  nombre: string | null | undefined,
): boolean {
  if (tipo === 'video') return true;
  if (tipo !== 'image') return false;
  const mime = (mimeType ?? '').toLowerCase();
  if (mime === 'image/gif' || mime === 'image/webp') return false;
  return !SIN_COMPRIMIR.has(extension(nombre));
}

/**
 * El mismo nombre con otra extensión.
 *
 * Tras comprimir, una foto `IMG_1.HEIC` es un JPG. Si conservara su nombre,
 * al guardarla en la galería el teléfono la trataría como lo que ya no es.
 */
export function conExtension(nombre: string | null | undefined, ext: string): string | null {
  if (!nombre) return null;
  const punto = nombre.lastIndexOf('.');
  const base = punto > 0 ? nombre.slice(0, punto) : nombre;
  return ext ? `${base}.${ext}` : base;
}

/**
 * Cuánto va hecho del envío de UN archivo, de 0 a 1, contando la compresión.
 *
 * Comprimir un video tarda tanto como subirlo. Si la barra solo contara la
 * subida, se quedaría quieta en cero la mitad del tiempo y parecería colgada.
 * Con video, la primera mitad de la barra es comprimir y la segunda, subir.
 * Una foto se comprime en un instante: toda la barra es la subida.
 */
export function avanceDelEnvio(
  fase: 'comprimiendo' | 'subiendo',
  ratio: number,
  comprimeVideo: boolean,
): number {
  const r = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  if (!comprimeVideo) return fase === 'comprimiendo' ? 0 : r;
  return fase === 'comprimiendo' ? r / 2 : 0.5 + r / 2;
}

// ---------------------------------------------------------------------------
// La portada de un video
// ---------------------------------------------------------------------------

/** Cómo termina, en el almacén, el nombre de la portada de un video. */
export const SUFIJO_DE_PORTADA = '.portada.jpg';

/**
 * Dónde vive, en el almacén, la imagen de portada de un video.
 *
 * AL LADO DEL VIDEO Y CON SU MISMO NOMBRE. La ruta de un adjunto lleva el
 * permiso (`<conversación>/<quien sube>/<archivo>`): al colgar de la misma
 * carpeta, la portada la puede leer exactamente quien puede ver el video, y
 * se va con él cuando se limpia la carpeta. No hace falta guardar la ruta en
 * ninguna tabla: quien conoce el video sabe dónde está su portada.
 */
export function rutaDePortada(rutaDelVideo: string): string {
  return `${rutaDelVideo}${SUFIJO_DE_PORTADA}`;
}

export function esRutaDePortada(ruta: string): boolean {
  return ruta.endsWith(SUFIJO_DE_PORTADA);
}

/**
 * Un nombre de archivo válido para guardar en el teléfono la portada de esa
 * ruta: sin barras ni nada que una carpeta no admita.
 */
export function nombreLocalDePortada(rutaDelVideo: string): string {
  return rutaDelVideo.replace(/[^A-Za-z0-9_-]+/g, '_').slice(-120);
}

/** `1:05`, o vacío si no se sabe cuánto dura. */
export function duracionDeVideo(segundos: number | null | undefined): string {
  if (!segundos || !Number.isFinite(segundos) || segundos <= 0) return '';
  const total = Math.round(segundos);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Cómo se pinta
// ---------------------------------------------------------------------------

type MensajeMinimo = {
  texto?: string | null;
  eliminado?: boolean;
  conCita?: boolean;
  conHistoria?: boolean;
  /** `title`: el nombre de un video (0113). Con nombre lleva burbuja. */
  adjuntos?: readonly { kind: TipoDeMedio; title?: string | null }[] | null;
};

/** Si todo lo que lleva el mensaje son fotos y videos. */
export function soloLlevaMedios(adjuntos: MensajeMinimo['adjuntos']): boolean {
  return (
    !!adjuntos &&
    adjuntos.length > 0 &&
    adjuntos.every((a) => a.kind === 'image' || a.kind === 'video')
  );
}

/**
 * Si el mensaje se pinta SIN MARCO: la foto sola, sin burbuja alrededor.
 *
 * Lo pedido con captura el 12/10/2026: la foto llevaba un marco negro (el
 * color de la burbuja propia) que la afeaba. Una foto o un video que van
 * solos no necesitan burbuja: ya tienen sus bordes.
 *
 * Con texto, con una cita o respondiendo a una historia, la burbuja se queda
 * —esas cosas necesitan un fondo sobre el que leerse— y la foto va dentro
 * con un marco fino.
 */
export function vaSinMarco(mensaje: MensajeMinimo): boolean {
  if (mensaje.eliminado || mensaje.conCita || mensaje.conHistoria) return false;
  if ((mensaje.texto ?? '').trim()) return false;
  // Un video con nombre (audios y temas, 30/10/2026) lleva su tarjeta, y el
  // nombre, como un texto, necesita la burbuja detrás para leerse.
  if (mensaje.adjuntos?.some((a) => a.kind === 'video' && !!a.title?.trim())) return false;
  return soloLlevaMedios(mensaje.adjuntos);
}

/** El peso de un archivo como se lee: `687 KB`, `2.4 MB`. */
export function pesoLegible(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export type TonoDeArchivo = 'rojo' | 'azul' | 'verde' | 'ambar' | 'morado' | 'gris';

export type AspectoDeArchivo = {
  /** Lo que se lee en el recuadro: `PDF`, `DOCX`. Vacío si va un icono. */
  sigla: string;
  /** El icono de Feather, cuando una sigla no diría nada. */
  icono: 'image' | 'film' | 'music' | 'archive' | 'file' | null;
  tono: TonoDeArchivo;
};

const TONO_POR_EXTENSION: Record<string, TonoDeArchivo> = {
  pdf: 'rojo',
  doc: 'azul',
  docx: 'azul',
  txt: 'gris',
  csv: 'verde',
  xls: 'verde',
  xlsx: 'verde',
  ppt: 'ambar',
  pptx: 'ambar',
  html: 'azul',
  htm: 'azul',
};

/**
 * Cómo se reconoce un archivo de un vistazo: un recuadro de color con su
 * tipo escrito, como hacen los chats que la gente ya usa. Rojo un PDF, azul
 * un documento, verde una hoja de cálculo.
 */
export function aspectoDeArchivo(
  mimeType: string | null | undefined,
  nombre: string | null | undefined,
): AspectoDeArchivo {
  const mime = (mimeType ?? '').toLowerCase();
  const ext = extension(nombre);
  if (mime.startsWith('image/')) return { sigla: '', icono: 'image', tono: 'morado' };
  if (mime.startsWith('video/')) return { sigla: '', icono: 'film', tono: 'morado' };
  if (mime.startsWith('audio/')) return { sigla: '', icono: 'music', tono: 'ambar' };
  if (ext === 'zip' || ext === 'rar' || ext === '7z' || mime === 'application/zip') {
    return { sigla: '', icono: 'archive', tono: 'ambar' };
  }
  // Hasta cuatro letras caben en el recuadro; más, se cortan y no dicen nada.
  if (ext && ext.length <= 4) {
    return { sigla: ext.toUpperCase(), icono: null, tono: TONO_POR_EXTENSION[ext] ?? 'gris' };
  }
  return { sigla: '', icono: 'file', tono: 'gris' };
}

/** Lo que va debajo del nombre: `PDF · 687 KB`. */
export function detalleDeArchivo(
  nombre: string | null | undefined,
  bytes: number | null | undefined,
): string {
  const ext = extension(nombre).toUpperCase();
  const peso = pesoLegible(bytes);
  return [ext, peso].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// Al descargar
// ---------------------------------------------------------------------------

/**
 * Si un archivo es, en realidad, una foto o un video, aunque se haya mandado
 * como archivo. Esos se pueden ver dentro de la aplicación, en el visor.
 */
export function medioQueEs(
  mimeType: string | null | undefined,
  nombre: string | null | undefined,
): 'image' | 'video' | null {
  const mime = (mimeType ?? '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  const ext = extension(nombre);
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'webm', '3gp'].includes(ext)) return 'video';
  return null;
}

/**
 * Adónde va un archivo al descargarlo.
 *
 * `galeria`: una foto o un video, a la galería del teléfono, sin preguntar.
 * `carpeta`: todo lo demás. Android no deja que una aplicación escriba donde
 * quiera: la persona elige UNA vez una carpeta y, desde entonces, las
 * descargas van ahí directamente.
 */
export function destinoDeDescarga(
  mimeType: string | null | undefined,
  nombre: string | null | undefined,
): 'galeria' | 'carpeta' {
  return medioQueEs(mimeType, nombre) ? 'galeria' : 'carpeta';
}

/**
 * El nombre con el que se guarda: sin lo que un sistema de archivos rechaza
 * y siempre con algo delante del punto.
 */
export function nombreParaGuardar(
  nombre: string | null | undefined,
  extensionPorDefecto: string,
): string {
  const limpio = (nombre ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(-120);
  if (!limpio) return `archivo-de-z.${extensionPorDefecto}`;
  return extension(limpio) ? limpio : `${limpio}.${extensionPorDefecto}`;
}

/**
 * El tope de lo que se puede guardar en la carpeta elegida.
 *
 * Para escribir ahí, el teléfono tiene que tener el archivo entero en memoria
 * (Android no da otra forma a una aplicación). Con archivos muy grandes eso
 * la cierra de golpe; es preferible decir que no. Fotos y videos no pasan por
 * aquí —van a la galería, que sí copia por trozos— y no tienen este tope.
 */
export const MAX_BYTES_A_CARPETA = 40 * 1024 * 1024;

export function cabeEnLaCarpeta(bytes: number | null | undefined): boolean {
  return !bytes || bytes <= MAX_BYTES_A_CARPETA;
}

/**
 * Cómo se llama, para decírselo a la persona, la carpeta que eligió.
 *
 * Android la da como una dirección interna
 * (`content://…/tree/primary%3ADocuments%2FZ`); lo que se lee es el final: «Z».
 * Si no se entiende, no se inventa un nombre: se devuelve vacío y quien avisa
 * dice solo «en la carpeta que elegiste».
 */
export function nombreDeCarpetaElegida(uri: string | null | undefined): string {
  if (!uri) return '';
  const ultimo = uri.split('/').filter(Boolean).pop() ?? '';
  let legible = ultimo;
  try {
    legible = decodeURIComponent(ultimo);
  } catch {
    // Se queda como vino.
  }
  // `primary:Documents/Z` → `Z`.
  const trasElDisco = legible.includes(':') ? legible.slice(legible.indexOf(':') + 1) : legible;
  return trasElDisco.split('/').filter(Boolean).pop() ?? '';
}
