/**
 * Los archivos que viajan por un chat privado.
 *
 * POR QUE UN BUCKET APARTE Y NO EL DE LAS PUBLICACIONES. `post-media` deja leer
 * a CUALQUIER cuenta autenticada, y desde la migración 0018 sus imágenes y
 * vídeos incluso sin cuenta —para que el muro se vea antes de registrarse—. Una
 * foto mandada a UNA persona por privado no puede vivir ahí: sería legible por
 * todo el que tenga la aplicación instalada. `message-media` es privado y su
 * política no pregunta «¿tienes cuenta?» sino «¿eres miembro de ESA
 * conversación?».
 *
 * LA RUTA ES LA QUE LLEVA EL PERMISO, y por eso tiene esta forma exacta:
 *
 *     <id de conversacion>/<id de quien sube>/<fichero>
 *
 * Storage no puede consultar la tabla de adjuntos para decidir: solo sabe del
 * nombre del objeto. Así que la primera carpeta dice de qué conversación es —y
 * la política comprueba la pertenencia— y la segunda obliga a que cada persona
 * escriba solo bajo su propio identificador. El backend valida la MISMA forma
 * antes de guardar la fila, de modo que si una de las dos comprobaciones fallara
 * la otra sigue en pie.
 *
 * LOS BYTES NO PASAN POR EL BACKEND. Se suben directamente desde aquí con el
 * token de la persona, igual que hacen las publicaciones; a la API solo viaja la
 * ruta. Es lo que permite mandar un vídeo grande por trozos reanudables sin que
 * el servidor tenga que sostener la conexión mientras tanto.
 *
 * LAS FOTOS Y LOS VIDEOS SE ACHICAN ANTES DE SUBIR (12/10/2026). Hasta ese día
 * el chat mandaba el original de la cámara —fotos de 3 a 8 MB, videos de 100 MB
 * por minuto— aunque las publicaciones llevaban meses comprimiéndose. Era la
 * raíz de que una foto del chat tardara en aparecer: cada persona del grupo
 * bajaba varios megas para verla en una burbuja. Un archivo mandado como
 * «Archivo» sigue llegando tal cual. Ver `lib/mediosDeChat.ts`.
 */
import {
  avanceDelEnvio,
  conExtension,
  esRutaDePortada,
  nombreLocalDePortada,
  rutaDePortada,
  seComprime,
} from '@/lib/mediosDeChat';
import {
  MAX_ARCHIVOS_DE_UNA_VEZ,
  limpiarTitulo,
  tipoDeArchivoElegido,
} from '@/lib/nombresDeAdjuntos';
import { tipoDeContenidoDe } from '@/lib/tiposDeArchivo';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';

import { olvidarCopiasDeChat, recordarCopia, recordarPortada } from '@/services/copiasDeChat';
import {
  compressImage,
  compressVideo,
  compressionAvailable,
  createVideoPoster,
} from '@/services/mediaCompressor';
import { uploadResumable } from '@/services/resumableUpload';
import {
  describeStorageError,
  formatMb,
  MAX_UPLOAD_BYTES,
  PermisoDenegadoError,
  randomName,
  readLocalFile,
  RESUMABLE_THRESHOLD,
  type UploadProgress,
} from '@/services/storage';
import { supabase, supabaseUrl } from '@/services/supabase';

const BUCKET = 'message-media';
const SIGNED_URL_TTL = 60 * 60; // 1 hora

/**
 * Tope propio, más bajo que el general de la aplicación.
 *
 * Un chat no es el sitio de un vídeo de curso de dos gigas: al otro lado hay
 * alguien con datos móviles que no ha pedido descargar nada. Cien megas es
 * holgado para un vídeo corto y coincide con el límite del bucket, así que el
 * rechazo se nota AQUI —antes de subir nada— en vez de a mitad de la subida.
 */
export const MAX_ADJUNTO_BYTES = Math.min(100 * 1024 * 1024, MAX_UPLOAD_BYTES);

/** Cuántos archivos caben en un mensaje. El backend aplica el mismo tope. */
export const MAX_ADJUNTOS = 10;

/**
 * Los tipos que la interfaz sabe pintar.
 *
 * `audio` son las notas de voz y lo añade la migración 0044. NO se manda como
 * `document` para no tocar el `CHECK` de la tabla: la burbuja no sabría que eso
 * se reproduce y la duración no significaría nada. Mientras la 0044 no esté
 * aplicada, la interfaz ni siquiera ofrece grabar.
 */
export type TipoDeAdjunto = 'image' | 'video' | 'document' | 'audio';

/** Un archivo elegido, todavía sin subir. */
export type AdjuntoElegido = {
  uri: string;
  kind: TipoDeAdjunto;
  /** El nombre que le puso su dueño. Para un documento es lo único que lo dice. */
  name: string | null;
  mimeType: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  durationS: number | null;
  /**
   * El nombre que se le pone al enviarlo (0113): el de la nota de voz o el
   * de cada archivo de «Enviar N archivos». Sin él, sale sin nombre.
   */
  title?: string | null;
  /**
   * Solo en un audio: `false` para un archivo de audio elegido con
   * «Archivo». Sin el campo, un audio es una nota de voz, como siempre.
   */
  voiceNote?: boolean;
};

/** Un archivo ya subido, listo para mandarle la ruta al backend. */
export type AdjuntoSubido = {
  storage_path: string;
  kind: TipoDeAdjunto;
  mime_type: string | null;
  file_name: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  /**
   * Nuevos con la 0113, y SOLO SI HAY ALGO QUE DECIR: una API anterior los
   * ignora, y una nota de voz sin nombre viaja exactamente como antes.
   */
  title?: string;
  voice_note?: boolean;
};

const AVISO_FOTOS =
  'Z no tiene permiso para acceder a tus fotos. Actívalo en la configuración del ' +
  'teléfono → Z → Fotos.';
const AVISO_CAMARA =
  'Z no tiene permiso para usar la cámara. Actívalo en la configuración del ' +
  'teléfono → Z → Cámara.';

// ---------------------------------------------------------------------------
// Elegir
// ---------------------------------------------------------------------------

function desdeAsset(asset: ImagePicker.ImagePickerAsset): AdjuntoElegido {
  const esVideo = asset.type === 'video';
  return {
    uri: asset.uri,
    kind: esVideo ? 'video' : 'image',
    name: asset.fileName ?? null,
    mimeType: asset.mimeType ?? null,
    bytes: asset.fileSize ?? null,
    width: asset.width ?? null,
    height: asset.height ?? null,
    // El selector informa la duración en milisegundos; el backend la guarda en
    // segundos, que es como la lee un reproductor.
    durationS: asset.duration ? asset.duration / 1000 : null,
  };
}

/**
 * Fotos y vídeos de la galería.
 *
 * Un permiso denegado LANZA en vez de devolver `null`, porque `null` ya
 * significa «la persona canceló». Confundir los dos casos es lo que deja un
 * botón mudo para siempre: en iOS el sistema solo pregunta UNA vez, así que si
 * se rechazó en su día todas las llamadas siguientes fallan calladas y la única
 * salida es activarlo a mano en los ajustes del teléfono.
 */
export async function elegirFotosOVideos(
  maximo: number = MAX_ADJUNTOS,
): Promise<AdjuntoElegido[]> {
  const permiso = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permiso.granted) throw new PermisoDenegadoError(AVISO_FOTOS);

  const resultado = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images', 'videos'],
    allowsMultipleSelection: maximo > 1,
    selectionLimit: maximo,
    videoQuality: ImagePicker.UIImagePickerControllerQualityType.Medium,
  });
  if (resultado.canceled) return [];
  return (resultado.assets ?? []).map(desdeAsset);
}

/**
 * Una foto de la galería, recortada antes de mandarla.
 *
 * EL RECORTE LO HACE EL EDITOR DEL TELÉFONO (`allowsEditing`), el mismo de la
 * foto de perfil y la del grupo: Z no trae uno propio. De ahí salen sus dos
 * límites, que no se pueden levantar desde aquí:
 *
 *   · es UNA foto por vez. El editor del sistema no recorta varias, y por
 *     eso esto va aparte de «Fotos y videos», que sí deja elegir varias;
 *   · en Android el marco es libre; en iOS el recorte es siempre cuadrado.
 *
 * Lo que sale es una foto como cualquier otra: se achica y se sube igual.
 */
export async function elegirFotoRecortada(): Promise<AdjuntoElegido | null> {
  const permiso = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permiso.granted) throw new PermisoDenegadoError(AVISO_FOTOS);

  const resultado = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
  });
  if (resultado.canceled) return null;
  const asset = resultado.assets?.[0];
  return asset ? desdeAsset(asset) : null;
}

/** Una foto recién hecha con la cámara. */
export async function hacerFoto(): Promise<AdjuntoElegido | null> {
  const permiso = await ImagePicker.requestCameraPermissionsAsync();
  if (!permiso.granted) throw new PermisoDenegadoError(AVISO_CAMARA);

  const resultado = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'] });
  if (resultado.canceled) return null;
  const asset = resultado.assets?.[0];
  return asset ? desdeAsset(asset) : null;
}

/**
 * Archivos cualquiera: PDF, hoja de cálculo, comprimido, audio...
 *
 * HASTA DIEZ DE UNA VEZ (audios y temas, 30/10/2026). Cada uno sale después
 * como su propio mensaje, con su nombre (`HojaDeEnviarArchivos`). El selector
 * del sistema no sabe de topes, así que se quedan los diez primeros y
 * `sobran` dice cuántos se dejaron fuera, para contarlo.
 *
 * Se marca como `document` aunque el sistema devuelva una imagen: lo que decide
 * cómo se pinta es por dónde se eligió. Alguien que entra por «Archivo» espera
 * ver el nombre del fichero, no una miniatura sin nombre que no puede guardar.
 *
 * SALVO UN AUDIO que se sabe reproducir (mp3, m4a, aac, ogg, wav): ese va como
 * `audio` con `voiceNote: false`, y en el chat se escucha en vez de bajarse.
 * Ver `tipoDeArchivoElegido`. SOLO CON `audios`, que es tener la 0113 en el
 * servidor (`attachment_titles`): una API anterior rechaza un audio que no
 * es nota de voz porque no trae duración, así que sin ella va como documento,
 * exactamente igual que antes.
 */
export async function elegirArchivo(
  maximo: number = MAX_ARCHIVOS_DE_UNA_VEZ,
  { audios = true }: { audios?: boolean } = {},
): Promise<{ archivos: AdjuntoElegido[]; sobran: number }> {
  const resultado = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
    multiple: maximo > 1,
  });
  if (resultado.canceled) return { archivos: [], sobran: 0 };
  const todos = resultado.assets ?? [];
  const tope = Math.max(1, maximo);
  return {
    archivos: todos.slice(0, tope).map((asset): AdjuntoElegido => {
      const kind = audios ? tipoDeArchivoElegido(asset.mimeType, asset.name) : 'document';
      return {
        uri: asset.uri,
        kind,
        name: asset.name ?? null,
        mimeType: asset.mimeType ?? null,
        bytes: asset.size ?? null,
        width: null,
        height: null,
        durationS: null,
        ...(kind === 'audio' ? { voiceNote: false } : {}),
      };
    }),
    sobran: Math.max(0, todos.length - tope),
  };
}

// ---------------------------------------------------------------------------
// Subir
// ---------------------------------------------------------------------------

function extensionDe(adjunto: AdjuntoElegido): string {
  const delNombre = adjunto.name?.split('.').pop()?.toLowerCase();
  if (delNombre && delNombre.length <= 6 && /^[a-z0-9]+$/.test(delNombre)) {
    return delNombre;
  }
  const deLaRuta = adjunto.uri.split('?')[0]?.split('.').pop()?.toLowerCase();
  if (deLaRuta && deLaRuta.length <= 6 && /^[a-z0-9]+$/.test(deLaRuta)) return deLaRuta;
  if (adjunto.kind === 'image') return 'jpg';
  if (adjunto.kind === 'video') return 'mp4';
  // `m4a` y no `bin` para una nota de voz: sin extensión reconocible, algunos
  // reproductores no saben qué decodificador abrir y la nota no suena.
  if (adjunto.kind === 'audio') return 'm4a';
  return 'bin';
}

function tipoDeContenido(adjunto: AdjuntoElegido, ext: string): string {
  // El teléfono no siempre dice el tipo, o dice uno genérico: un audio o un
  // HTML llegaban como «archivo desconocido» y el almacén los rechazaba.
  const deducido = tipoDeContenidoDe(adjunto.mimeType, adjunto.name ?? `archivo.${ext}`);
  if (deducido !== 'application/octet-stream') return deducido;
  if (adjunto.kind === 'image') return `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  if (adjunto.kind === 'video') return `video/${ext}`;
  // El bucket `message-media` admite `audio/*` desde la 0033, así que esto pasa
  // su lista de tipos permitidos. `application/octet-stream` NO pasaría.
  if (adjunto.kind === 'audio') return ext === 'm4a' ? 'audio/mp4' : `audio/${ext}`;
  return 'application/octet-stream';
}

/**
 * Deja la portada de un video al lado del video, en el almacén.
 *
 * Es lo que ven los demás en la burbuja antes de reproducirlo. Va ANTES de
 * mandar el mensaje: cuando alguien lo recibe, la portada ya está.
 *
 * NUNCA LANZA. Sin portada el video se manda igual; quien lo reciba la sacará
 * del propio video (`generarPortada`).
 */
async function subirPortada(rutaDelVideo: string, uriDelVideo: string): Promise<void> {
  if (!supabase) return;
  try {
    const portada = await createVideoPoster(uriDelVideo, nombreLocalDePortada(rutaDelVideo));
    if (!portada?.uri) return;
    // Quien manda ya la tiene: su burbuja no espera a nadie.
    recordarPortada(rutaDelVideo, portada.uri);
    const archivo = await readLocalFile(portada.uri);
    if (archivo.size === 0) return;
    await supabase.storage
      .from(BUCKET)
      .upload(rutaDePortada(rutaDelVideo), await archivo.directBody(), {
        contentType: 'image/jpeg',
        upsert: false,
      });
  } catch {
    // Sin portada no se pierde el envío.
  }
}

/**
 * Sube un archivo al bucket privado y devuelve lo que el backend necesita.
 *
 * `onProgress` recibe el avance real del envío, no una animación: mandar un
 * vídeo por datos móviles tarda, y una barra que no se mueve es indistinguible
 * de una aplicación colgada. El `ratio` es el de TODO el envío de ese archivo,
 * comprimir incluido: ver `avanceDelEnvio`.
 */
export async function subirAdjunto(
  conversationId: string,
  adjunto: AdjuntoElegido,
  onProgress?: (progreso: UploadProgress) => void,
): Promise<AdjuntoSubido> {
  if (!supabase) throw new Error('Almacenamiento no disponible.');

  const { data } = await supabase.auth.getSession();
  const sesion = data.session;
  const uid = sesion?.user?.id;
  if (!sesion || !uid) throw new Error('Inicia sesión para enviar archivos.');

  /*
    1. ACHICAR EN EL TELÉFONO, si es una foto o un video (no hace nada en la
    web ni en Expo Go). Si falla, se manda el original: comprimir es una
    mejora, no una condición para poder enviar.
  */
  const esVideo = adjunto.kind === 'video';
  const comprime =
    compressionAvailable && seComprime(adjunto.kind, adjunto.mimeType, adjunto.name);
  const avisar = (fase: 'comprimiendo' | 'subiendo', ratio: number) =>
    onProgress?.({
      phase: fase === 'comprimiendo' ? 'compressing' : 'uploading',
      ratio: avanceDelEnvio(fase, ratio, comprime && esVideo),
    });

  let uri = adjunto.uri;
  if (comprime) {
    try {
      avisar('comprimiendo', 0);
      uri = esVideo
        ? await compressVideo(adjunto.uri, (ratio) => avisar('comprimiendo', ratio))
        : await compressImage(adjunto.uri);
    } catch {
      uri = adjunto.uri;
    }
  }
  const comprimido = uri !== adjunto.uri;
  // Tras comprimir el archivo es otro (un JPG, un MP4): ni el nombre ni el
  // tipo que dio el teléfono describen ya lo que se sube.
  const final: AdjuntoElegido = comprimido
    ? { ...adjunto, uri, name: null, mimeType: null }
    : adjunto;

  const ext = extensionDe(final);
  // La ruta ES el permiso: conversación primero, persona después. Cambiar este
  // orden rompería la política del bucket sin que ningún tipo lo avisara.
  const ruta = `${conversationId}/${uid}/${randomName(ext)}`;
  const contentType = tipoDeContenido(final, ext);

  // Los bytes reales. En React Native `fetch(uri).blob()` devuelve un Blob que
  // informa bien su tamaño pero viaja VACIO en el POST: las fotos se subían con
  // 0 bytes. `readLocalFile` es lo que resolvió eso, y por eso se reutiliza en
  // vez de volver a escribirlo aquí.
  const local = await readLocalFile(uri);
  if (local.size === 0) throw new Error('El archivo seleccionado está vacío.');
  if (local.size > MAX_ADJUNTO_BYTES) {
    throw new Error(
      `El archivo pesa ${formatMb(local.size)} y por el chat se pueden mandar ` +
        `hasta ${formatMb(MAX_ADJUNTO_BYTES)}. Comprímelo o mándalo por otra vía.`,
    );
  }

  // 2. LA PORTADA, si es un video. Antes que el video: es pequeña y, si el
  // envío se corta a medias, no deja nada a la vista de nadie.
  if (esVideo) await subirPortada(ruta, uri);

  avisar('subiendo', 0);

  if (local.size > RESUMABLE_THRESHOLD && supabaseUrl) {
    // Archivo grande: por trozos, para sobrevivir a un corte de red.
    const { done } = uploadResumable({
      supabaseUrl,
      accessToken: sesion.access_token,
      bucket: BUCKET,
      path: ruta,
      file: await local.resumableBody(),
      contentType,
      onProgress: (ratio) => avisar('subiendo', ratio),
    });
    try {
      await done;
    } catch (error) {
      throw new Error(describeStorageError(error));
    }
  } else {
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(ruta, await local.directBody(), { contentType, upsert: false });
    if (error) throw new Error(describeStorageError(error));
    avisar('subiendo', 1);
  }

  // 3. Lo que se acaba de subir ESTÁ en este teléfono: la burbuja lo pinta de
  // aquí en vez de volver a bajarlo del servidor. Solo fotos y videos, que es
  // lo que se ve; un archivo o una nota de voz no ganan nada con esto.
  if (adjunto.kind === 'image' || esVideo) recordarCopia(ruta, uri);

  return {
    storage_path: ruta,
    kind: adjunto.kind,
    // El tipo con el que de verdad se subió, no el que dijo el teléfono.
    mime_type: contentType,
    // Con el nombre de siempre, pero la extensión de lo que es ahora.
    file_name: comprimido ? conExtension(adjunto.name, ext) : adjunto.name,
    // El tamaño REAL del archivo leído, no el que informó el selector: no
    // siempre coinciden, y el que cuenta es el que se ha subido.
    bytes: local.size,
    width: adjunto.width,
    height: adjunto.height,
    duration_s: adjunto.durationS,
    ...camposDeNombre(adjunto),
  };
}

/**
 * El nombre y la marca de nota de voz, solo cuando hay algo que decir.
 *
 * Una foto no lleva nombre (el servidor lo ignoraría). Un audio dice si es
 * nota de voz SOLO si no lo es: sin el campo, el servidor entiende que sí,
 * que es lo que mandan también las versiones que ya están en los teléfonos.
 */
function camposDeNombre(adjunto: AdjuntoElegido): Pick<AdjuntoSubido, 'title' | 'voice_note'> {
  const titulo = adjunto.kind === 'image' ? null : limpiarTitulo(adjunto.title);
  return {
    ...(titulo ? { title: titulo } : {}),
    ...(adjunto.kind === 'audio' && adjunto.voiceNote === false ? { voice_note: false } : {}),
  };
}

// ---------------------------------------------------------------------------
// Ver
// ---------------------------------------------------------------------------

/**
 * Cache de URLs firmadas de adjuntos.
 *
 * Cada llamada a `createSignedUrls` devuelve una firma DISTINTA para el mismo
 * archivo, así que sin cache la URL cambiaba en cada repintado del chat y la
 * imagen se volvía a descargar entera en vez de salir de la cache del sistema.
 * Se renueva diez minutos antes de caducar para no servir un enlace muerto.
 *
 * SOLO EN MEMORIA, y esto es distinto de lo que hace `storage.ts` con las fotos
 * del muro: aquello se guarda en disco para que el feed salga al instante al
 * reabrir. Una firma de un adjunto privado guardada en disco es un enlace a
 * contenido privado que sobrevive al cierre de sesión, y no merece la pena por
 * ahorrar una firma.
 */
const CACHE_TTL_MS = (SIGNED_URL_TTL - 600) * 1000;
const firmas = new Map<string, { url: string; caducaEn: number }>();

/**
 * Portadas que el almacén dijo que no existen.
 *
 * Los videos anteriores al 12/10/2026 no tienen portada subida. Sin apuntarlo,
 * cada página del chat volvería a preguntar por ellas y ninguna firma saldría
 * nunca de la cache: una petición de más en cada apertura, para siempre. SOLO
 * PORTADAS: que falte la firma de un adjunto de verdad puede ser un corte de
 * red, y eso sí se reintenta.
 */
const portadasQueNoEstan = new Set<string>();

/** Firma varias rutas de golpe y reutiliza las que sigan vigentes. */
export async function firmarAdjuntos(
  rutas: readonly string[],
): Promise<Record<string, string>> {
  // Lista vacía = no se consulta. Pedir una firma de nada devuelve un error que
  // no significa nada.
  if (!supabase || rutas.length === 0) return {};

  const ahora = Date.now();
  const mapa: Record<string, string> = {};
  const faltan: string[] = [];
  for (const ruta of rutas) {
    const vigente = firmas.get(ruta);
    if (vigente && vigente.caducaEn > ahora) mapa[ruta] = vigente.url;
    else if (!portadasQueNoEstan.has(ruta)) faltan.push(ruta);
  }
  if (faltan.length === 0) return mapa;

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrls(faltan, SIGNED_URL_TTL);
  // Sin firma no hay imagen, pero tampoco hay motivo para tumbar el chat: los
  // mensajes de texto se siguen leyendo y el adjunto enseña su hueco.
  if (error || !data) return mapa;

  const caducaEn = ahora + CACHE_TTL_MS;
  for (const item of data) {
    if (item.path && item.signedUrl) {
      mapa[item.path] = item.signedUrl;
      firmas.set(item.path, { url: item.signedUrl, caducaEn });
    }
  }
  // El almacén contestó y esa portada no vino: no existe.
  for (const ruta of faltan) {
    if (!mapa[ruta] && esRutaDePortada(ruta)) portadasQueNoEstan.add(ruta);
  }
  return mapa;
}

/**
 * Se vacía al cerrar sesión: las firmas van atadas a quien las pidió, y lo que
 * este teléfono recordaba de los archivos de esa cuenta, también.
 */
export function olvidarFirmasDeAdjuntos(): void {
  firmas.clear();
  portadasQueNoEstan.clear();
  olvidarCopiasDeChat();
}
