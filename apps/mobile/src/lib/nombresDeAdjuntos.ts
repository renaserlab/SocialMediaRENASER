/**
 * Audios y temas (30/10/2026): el NOMBRE de un adjunto y los TEMAS de un
 * mensaje, en lo que se decide sin pantalla y sin red.
 *
 * El contrato está en `docs/CONTRATOS_AUDIOS_Y_TEMAS.md`. En corto:
 *
 *  - Una nota de voz, un archivo de audio, un documento o un video pueden
 *    llevar un nombre (`title`, hasta 80 caracteres). Lo ponen quien envió el
 *    mensaje y quien administra; con nombre, la burbuja empieza con una
 *    tarjeta, y sin nombre se ve exactamente como antes.
 *  - Un mensaje de General que está en uno o más temas lleva debajo una
 *    etiqueta con el tema, o «En N temas».
 *  - Al mandar varios archivos a la vez, cada uno sale con un nombre que
 *    empieza siendo el de su fichero, salvo los de cámara, que no dicen nada.
 *
 * LOS PERMISOS NO ESTÁN AQUÍ. `puedeNombrar` solo evita ofrecer lo que el
 * servidor rechazaría con un 403; quien decide es el `PATCH`.
 *
 * Sin importaciones, a propósito: se prueba con `node --test` tal cual, como
 * `vistasDeChat.ts` y `temasDeGrupo.ts`.
 */

// ---------------------------------------------------------------------------
// El nombre
// ---------------------------------------------------------------------------

/** El tope del servidor (`char_length(title) between 1 and 80`, 0113). */
export const MAX_TITULO_DE_ADJUNTO = 80;

/** Cuántos archivos se pueden elegir de una vez con «Archivo». */
export const MAX_ARCHIVOS_DE_UNA_VEZ = 10;

/** Lo que se puede nombrar. Una foto no: su nombre no se ve en ningún sitio. */
export type TipoNombrable = 'audio' | 'video' | 'document';

type AdjuntoMinimo = {
  id: string;
  kind: string;
  title?: string | null;
  voiceNote?: boolean;
};

export function seNombra(kind: string): kind is TipoNombrable {
  return kind === 'audio' || kind === 'video' || kind === 'document';
}

/** Los caracteres de control (Unicode Cc): saltos de línea, tabuladores, NUL… */
const CONTROLES = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * El nombre tal como se guarda: sin caracteres de control, sin espacios de
 * más y sin pasarse del tope. Vacío es `null`, que es «sin nombre» (y en el
 * `PATCH`, borrarlo).
 *
 * LOS CONTROLES SE VUELVEN ESPACIOS: el servidor rechaza un nombre que los
 * lleve (422 `attachment_title_invalid`), y llegan sin querer al pegar un
 * texto con saltos de línea en el campo.
 */
export function limpiarTitulo(texto: string | null | undefined): string | null {
  const limpio = (texto ?? '')
    .replace(CONTROLES, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITULO_DE_ADJUNTO)
    .trim();
  return limpio ? limpio : null;
}

/** Lo que manda el servidor en `title`, leído sin fiarse: solo texto con algo. */
export function leerTitulo(bruto: unknown): string | null {
  return typeof bruto === 'string' ? limpiarTitulo(bruto) : null;
}

/**
 * Si un audio es una nota de voz (micrófono) o un archivo de audio (nota
 * musical).
 *
 * UNA API SIN LA 0113 NO MANDA EL CAMPO, y hasta entonces todo audio era una
 * nota de voz: un archivo de audio se mandaba como documento. Por eso, sin
 * el campo, vale lo mismo que `kind === 'audio'`.
 */
export function leerNotaDeVoz(kind: string, bruto: unknown): boolean {
  if (kind !== 'audio') return false;
  return typeof bruto === 'boolean' ? bruto : true;
}

/** El primer adjunto del mensaje que puede llevar nombre, o `null`. */
export function adjuntoNombrable<T extends AdjuntoMinimo>(
  adjuntos: readonly T[] | null | undefined,
): T | null {
  return (adjuntos ?? []).find((adjunto) => seNombra(adjunto.kind)) ?? null;
}

/**
 * Si quien mira puede ponerle o cambiarle el nombre: quien lo envió y quien
 * administra (la misma regla que borrar, `router.py`). Comodidad, no permiso.
 */
export function puedeNombrar({
  mio,
  administra,
  adjunto,
}: {
  mio: boolean;
  administra: boolean;
  adjunto: { kind: string } | null | undefined;
}): boolean {
  return !!adjunto && seNombra(adjunto.kind) && (mio || administra);
}

/**
 * El icono del cuadrito de la tarjeta (Feather). `null` en un documento: ahí
 * va la sigla del archivo, como en su recuadro de siempre.
 */
export function iconoDeTarjeta(adjunto: {
  kind: string;
  voiceNote?: boolean;
}): 'mic' | 'music' | 'video' | null {
  if (adjunto.kind === 'video') return 'video';
  if (adjunto.kind === 'audio') return adjunto.voiceNote === false ? 'music' : 'mic';
  return null;
}

/**
 * Prefijos de los nombres que pone una cámara o una aplicación. No dicen nada
 * de lo que hay dentro («IMG_20261030_0915»): el campo queda vacío y quien
 * envía decide si le pone uno.
 */
const PREFIJOS_SIN_NOMBRE = ['img_', 'vid_', 'pxl_', 'whatsapp audio'];

/**
 * Los que pone WhatsApp en Android: `IMG-20261030-WA0001.jpg`,
 * `VID-…-WA…`, `AUD-…-WA…`, `PTT-…-WA…` (nota de voz) y `DOC-…-WA…`. Una
 * fecha y un contador: tampoco dicen nada.
 */
const DE_WHATSAPP_EN_ANDROID = /^(img|vid|aud|ptt|doc)-\d{8}-wa\d*/i;

/**
 * El nombre con el que empieza el campo de un archivo elegido: el del
 * fichero sin su extensión, con los guiones como espacios y la primera letra
 * en mayúscula (`respiracion-478.mp3` → «Respiracion 478»). Vacío si es de
 * cámara o de WhatsApp. Siempre se puede cambiar antes de enviar.
 */
export function nombrePorDefecto(nombreDelArchivo: string | null | undefined): string {
  const nombre = (nombreDelArchivo ?? '').trim();
  if (!nombre) return '';
  const minusculas = nombre.toLowerCase();
  if (PREFIJOS_SIN_NOMBRE.some((prefijo) => minusculas.startsWith(prefijo))) return '';
  if (DE_WHATSAPP_EN_ANDROID.test(nombre)) return '';
  // Solo se quita lo que parece una extensión: «Clase 3. Postura» no la tiene.
  const sinExtension = nombre.replace(/\.[A-Za-z0-9]{1,6}$/, '');
  const conEspacios = sinExtension.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!conEspacios) return '';
  const capital = conEspacios.charAt(0).toLocaleUpperCase() + conEspacios.slice(1);
  return capital.slice(0, MAX_TITULO_DE_ADJUNTO).trim();
}

/**
 * Los tipos de audio que se mandan como archivo de audio reproducible: mp3,
 * m4a, aac y wav (contrato §2), los que suenan en los dos teléfonos.
 *
 * OGG Y OPUS NO, aunque sean audio: iOS no sabe abrir ese contenedor, y la
 * burbuja de audio no tiene descarga, así que en un iPhone quedaría un play
 * que no suena y ninguna forma de sacarlo. Como documento se descargan. Lo
 * mismo con amr, flac o wma.
 */
const AUDIOS_REPRODUCIBLES: ReadonlySet<string> = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/x-aac',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/vnd.wave',
]);

const AUDIO_POR_EXTENSION: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
};

/** Tipos que el teléfono da cuando no sabe qué es (ver `tiposDeArchivo.ts`). */
const TIPOS_GENERICOS: ReadonlySet<string> = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/ogg',
  'application/x-ogg',
  '*/*',
]);

/**
 * Cómo se manda un archivo elegido con «Archivo»: como audio reproducible si
 * es uno de los de arriba, y si no, como documento. El tipo que dice el
 * teléfono manda; si no dice nada útil, la extensión.
 */
export function tipoDeArchivoElegido(
  mimeType: string | null | undefined,
  nombre: string | null | undefined,
): 'audio' | 'document' {
  const dicho = (mimeType ?? '').trim().toLowerCase();
  if (!TIPOS_GENERICOS.has(dicho)) return AUDIOS_REPRODUCIBLES.has(dicho) ? 'audio' : 'document';
  const extension = /\.([a-z0-9]{1,6})$/i.exec((nombre ?? '').split(/[?#]/)[0] ?? '')?.[1];
  return extension && AUDIO_POR_EXTENSION[extension.toLowerCase()] ? 'audio' : 'document';
}

/** Minutos y segundos de una duración, para decirla en voz alta. */
export function partesDeDuracion(segundos: number | null | undefined): {
  minutos: number;
  segundos: number;
} | null {
  if (typeof segundos !== 'number' || !Number.isFinite(segundos) || segundos <= 0) return null;
  const total = Math.max(1, Math.round(segundos));
  return { minutos: Math.floor(total / 60), segundos: total % 60 };
}

/** Le pone el nombre que dijo el servidor a un adjunto ya pintado. */
export function conTituloDeAdjunto<
  M extends { attachments?: readonly AdjuntoMinimo[] | AdjuntoMinimo[] },
>(mensajes: M[], adjuntoId: string, titulo: string | null): M[] {
  let cambio = false;
  const siguiente = mensajes.map((mensaje) => {
    if (!mensaje.attachments?.some((adjunto) => adjunto.id === adjuntoId)) return mensaje;
    cambio = true;
    return {
      ...mensaje,
      attachments: mensaje.attachments.map((adjunto) =>
        adjunto.id === adjuntoId ? { ...adjunto, title: titulo } : adjunto,
      ),
    };
  });
  return cambio ? siguiente : mensajes;
}

/**
 * Si un rechazo del servidor es por el nombre de un adjunto. Al enviar, un
 * mensaje con un nombre que no vale vuelve con uno de estos; se cuenta con el
 * texto del nombre y no con el genérico de «no se pudo enviar».
 */
export function esDelNombre(codigo: string | null | undefined): boolean {
  return (
    codigo === 'attachment_title_too_long' ||
    codigo === 'attachment_title_invalid' ||
    codigo === 'attachment_title_not_allowed'
  );
}

/** El texto de cada rechazo del `PATCH` del nombre. */
export function claveDelFalloDeNombre(codigo: string | null | undefined): string {
  switch (codigo) {
    case 'attachment_title_forbidden':
      return 'attachmentName.errorForbidden';
    case 'attachment_not_found':
      return 'attachmentName.errorGone';
    case 'attachment_title_too_long':
      return 'attachmentName.errorTooLong';
    case 'attachment_title_invalid':
      return 'attachmentName.errorInvalid';
    case 'attachment_title_not_allowed':
      return 'attachmentName.errorNotAllowed';
    case 'attachment_titles_not_available':
      return 'attachmentName.errorUnavailable';
    default:
      return 'attachmentName.errorGeneric';
  }
}

// ---------------------------------------------------------------------------
// Los temas de un mensaje
// ---------------------------------------------------------------------------

/** Un tema en el que está un mensaje de General. */
export type TemaDeMensaje = { id: string; nombre: string };

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * El `topics` de un mensaje: `[{id, name}]`. Lo que no se entiende se salta,
 * y un tema repetido sale una vez. Una API anterior no manda el campo: lista
 * vacía, y el mensaje se pinta como siempre.
 */
export function leerTemasDeMensaje(bruto: unknown): TemaDeMensaje[] {
  if (!Array.isArray(bruto)) return [];
  const vistos = new Set<string>();
  const salida: TemaDeMensaje[] = [];
  for (const fila of bruto) {
    if (!esObjeto(fila)) continue;
    const id = typeof fila.id === 'string' ? fila.id : '';
    const nombre = typeof fila.name === 'string' ? fila.name.trim() : '';
    if (!id || !nombre || vistos.has(id)) continue;
    vistos.add(id);
    salida.push({ id, nombre });
  }
  return salida;
}

/** Lo que dice `GET …/topics/of-messages`: `{"<message_id>": [{id, name}]}`. */
export function leerTemasDeMensajes(bruto: unknown): Record<string, TemaDeMensaje[]> {
  if (!esObjeto(bruto)) return {};
  const salida: Record<string, TemaDeMensaje[]> = {};
  for (const [id, temas] of Object.entries(bruto)) {
    if (id) salida[id] = leerTemasDeMensaje(temas);
  }
  return salida;
}

/** Cuántos ids caben en una pregunta a `of-messages` (contrato §2). */
export const MAX_CONSULTA_DE_TEMAS = 100;

/** Si dos listas de temas dicen lo mismo, en el mismo orden. */
export function mismosTemas(
  a: readonly TemaDeMensaje[] | null | undefined,
  b: readonly TemaDeMensaje[] | null | undefined,
): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((tema, i) => tema.id === y[i]?.id && tema.nombre === y[i]?.nombre);
}

/**
 * Pone los temas recién preguntados en los mensajes ya pintados.
 *
 * Un id preguntado que no viene en la respuesta ya no está en ningún tema.
 * SI NADA CAMBIA DEVUELVE LA MISMA LISTA, para que la pantalla no repinte el
 * chat entero por una respuesta que dice lo que ya se veía.
 */
export function aplicarTemas<M extends { id: string; temas?: TemaDeMensaje[] }>(
  mensajes: M[],
  preguntados: readonly string[],
  porMensaje: Record<string, TemaDeMensaje[]>,
): M[] {
  const pedidos = new Set(preguntados);
  let cambio = false;
  const siguiente = mensajes.map((mensaje) => {
    if (!pedidos.has(mensaje.id)) return mensaje;
    const nuevos = porMensaje[mensaje.id] ?? [];
    if (mismosTemas(mensaje.temas, nuevos)) return mensaje;
    cambio = true;
    return { ...mensaje, temas: nuevos.length > 0 ? nuevos : undefined };
  });
  return cambio ? siguiente : mensajes;
}

/** Qué etiqueta lleva un mensaje bajo la burbuja (y qué ofrece su menú). */
export type EtiquetaDeTemas =
  | { tipo: 'ninguna' }
  | { tipo: 'uno'; tema: TemaDeMensaje }
  | { tipo: 'varios'; cuantos: number };

export function etiquetaDeTemas(temas: readonly TemaDeMensaje[] | null | undefined): EtiquetaDeTemas {
  const lista = temas ?? [];
  const primero = lista[0];
  if (!primero) return { tipo: 'ninguna' };
  if (lista.length === 1) return { tipo: 'uno', tema: primero };
  return { tipo: 'varios', cuantos: lista.length };
}

/** Los mensajes por los que preguntar: los últimos ya guardados en el servidor. */
export function idsParaPreguntarTemas(
  mensajes: readonly { id: string; estado?: string; eliminado?: boolean; sesion?: unknown }[],
  maximo = MAX_CONSULTA_DE_TEMAS,
): string[] {
  return mensajes
    .filter((m) => !m.estado && !m.eliminado && !m.sesion && !m.id.startsWith('sesion:'))
    .slice(-maximo)
    .map((m) => m.id);
}

/** Pone o quita un id de una selección, sin tocar la original. */
export function alternarSeleccion(seleccion: readonly string[], id: string): string[] {
  return seleccion.includes(id) ? seleccion.filter((x) => x !== id) : [...seleccion, id];
}

/** El texto de cada rechazo del `PUT` por lotes; los demás, los de temas. */
export function claveDelFalloDeAgregarVarios(codigo: string | null | undefined): string | null {
  return codigo === 'message_not_in_group' ? 'contentTopics.errorNotInGroup' : null;
}
