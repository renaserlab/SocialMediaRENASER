/**
 * De qué tipo es un archivo que se adjunta en el chat.
 *
 * EL FALLO QUE ARREGLA (10/10/2026). El almacén del chat solo admite una lista
 * cerrada de tipos. El tipo lo dice el teléfono al elegir el archivo, y no
 * siempre lo dice bien: muchos Android entregan un audio (`.opus`, `.amr`,
 * `.m4a`) o una página (`.html`) SIN tipo, o como «archivo genérico». Subido
 * así, el almacén lo rechazaba y la persona veía que «no se puede subir un
 * audio». El archivo era correcto; lo que faltaba era decir qué es.
 *
 * Aquí el tipo se deduce de la EXTENSIÓN cuando el teléfono no lo da o da uno
 * genérico. Si el teléfono da uno concreto, se respeta.
 *
 * Sin importaciones, a propósito: se prueba con `node --test` tal cual.
 */

const POR_EXTENSION: Record<string, string> = {
  // Audio
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  amr: 'audio/amr',
  flac: 'audio/flac',
  wma: 'audio/x-ms-wma',
  '3ga': 'audio/3gpp',
  // Páginas y texto
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
  csv: 'text/csv',
  // Documentos
  pdf: 'application/pdf',
  zip: 'application/zip',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Imagen y vídeo
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  '3gp': 'video/3gpp',
};

/**
 * Tipos que el teléfono da cuando NO sabe qué es el archivo, o que el almacén
 * no admite aunque el archivo sea válido. `application/ogg` es cómo llegan
 * muchas notas de voz reenviadas desde otras aplicaciones: son audio.
 */
const GENERICOS: ReadonlySet<string> = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/ogg',
  'application/x-ogg',
  '*/*',
]);

/** La extensión de un nombre de archivo, en minúsculas y sin el punto. */
export function extensionDe(nombre: string | null | undefined): string {
  if (!nombre) return '';
  const limpio = nombre.split(/[?#]/)[0] ?? '';
  const punto = limpio.lastIndexOf('.');
  if (punto < 0 || punto === limpio.length - 1) return '';
  const ext = limpio.slice(punto + 1).toLowerCase();
  return /^[a-z0-9]{1,6}$/.test(ext) ? ext : '';
}

/**
 * El tipo con el que se sube un archivo.
 *
 * El que dice el teléfono, si dice algo concreto; si no, el de su extensión; y
 * si tampoco, el genérico —que el almacén rechazará con su mensaje, que es lo
 * correcto para un archivo que de verdad no se sabe qué es—.
 */
export function tipoDeContenidoDe(
  mime: string | null | undefined,
  nombre: string | null | undefined,
): string {
  const dicho = (mime ?? '').trim().toLowerCase();
  if (!GENERICOS.has(dicho)) return dicho;
  return POR_EXTENSION[extensionDe(nombre)] ?? (dicho || 'application/octet-stream');
}

/** Si un adjunto es una página HTML, por su tipo o por su nombre. */
export function esHtml(mime: string | null | undefined, nombre: string | null | undefined): boolean {
  const tipo = (mime ?? '').toLowerCase();
  if (tipo.startsWith('text/html') || tipo === 'application/xhtml+xml') return true;
  const ext = extensionDe(nombre);
  return ext === 'html' || ext === 'htm';
}

/** Si un adjunto es un audio, por su tipo o por su nombre. */
export function esAudio(mime: string | null | undefined, nombre: string | null | undefined): boolean {
  return tipoDeContenidoDe(mime, nombre).startsWith('audio/');
}

/**
 * La dirección de un archivo, pidiendo que se DESCARGUE en vez de abrirse.
 *
 * PARA LOS HTML. Una página que alguien manda por el chat no se abre como
 * página: se descarga como archivo. Abierta en el navegador se ejecutaría con
 * la dirección del almacén de Z delante, y eso es justo lo que necesita quien
 * quiera hacer pasar una página suya por una de Z.
 */
export function enlaceDeDescarga(url: string, nombre: string | null | undefined): string {
  if (!url || /[?&]download=/.test(url)) return url;
  const archivo = (nombre ?? '').trim() || 'archivo';
  return `${url}${url.includes('?') ? '&' : '?'}download=${encodeURIComponent(archivo)}`;
}
