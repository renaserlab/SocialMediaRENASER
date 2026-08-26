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
 */
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';

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

/** Los tres tipos que la interfaz sabe pintar. */
export type TipoDeAdjunto = 'image' | 'video' | 'document';

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
};

const AVISO_FOTOS =
  'Z no tiene permiso para acceder a tus fotos. Actívalo en Ajustes del ' +
  'teléfono → Z → Fotos.';
const AVISO_CAMARA =
  'Z no tiene permiso para usar la cámara. Actívalo en Ajustes del ' +
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
 * Un archivo cualquiera: PDF, hoja de cálculo, comprimido...
 *
 * Se marca como `document` aunque el sistema devuelva una imagen: lo que decide
 * cómo se pinta es por dónde se eligió. Alguien que entra por «Archivo» espera
 * ver el nombre del fichero, no una miniatura sin nombre que no puede guardar.
 */
export async function elegirArchivo(): Promise<AdjuntoElegido | null> {
  const resultado = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (resultado.canceled) return null;
  const asset = resultado.assets?.[0];
  if (!asset) return null;
  return {
    uri: asset.uri,
    kind: 'document',
    name: asset.name ?? null,
    mimeType: asset.mimeType ?? null,
    bytes: asset.size ?? null,
    width: null,
    height: null,
    durationS: null,
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
  return adjunto.kind === 'image' ? 'jpg' : adjunto.kind === 'video' ? 'mp4' : 'bin';
}

function tipoDeContenido(adjunto: AdjuntoElegido, ext: string): string {
  if (adjunto.mimeType) return adjunto.mimeType;
  if (adjunto.kind === 'image') return `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  if (adjunto.kind === 'video') return `video/${ext}`;
  return 'application/octet-stream';
}

/**
 * Sube un archivo al bucket privado y devuelve lo que el backend necesita.
 *
 * `onProgress` recibe el avance real de la subida, no una animación: mandar un
 * vídeo por datos móviles tarda, y una barra que no se mueve es indistinguible
 * de una aplicación colgada.
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

  const ext = extensionDe(adjunto);
  // La ruta ES el permiso: conversación primero, persona después. Cambiar este
  // orden rompería la política del bucket sin que ningún tipo lo avisara.
  const ruta = `${conversationId}/${uid}/${randomName(ext)}`;
  const contentType = tipoDeContenido(adjunto, ext);

  // Los bytes reales. En React Native `fetch(uri).blob()` devuelve un Blob que
  // informa bien su tamaño pero viaja VACIO en el POST: las fotos se subían con
  // 0 bytes. `readLocalFile` es lo que resolvió eso, y por eso se reutiliza en
  // vez de volver a escribirlo aquí.
  const local = await readLocalFile(adjunto.uri);
  if (local.size === 0) throw new Error('El archivo seleccionado está vacío.');
  if (local.size > MAX_ADJUNTO_BYTES) {
    throw new Error(
      `El archivo pesa ${formatMb(local.size)} y por el chat se pueden mandar ` +
        `hasta ${formatMb(MAX_ADJUNTO_BYTES)}. Comprímelo o mándalo por otra vía.`,
    );
  }

  onProgress?.({ phase: 'uploading', ratio: 0 });

  if (local.size > RESUMABLE_THRESHOLD && supabaseUrl) {
    // Archivo grande: por trozos, para sobrevivir a un corte de red.
    const { done } = uploadResumable({
      supabaseUrl,
      accessToken: sesion.access_token,
      bucket: BUCKET,
      path: ruta,
      file: await local.resumableBody(),
      contentType,
      onProgress: (ratio) => onProgress?.({ phase: 'uploading', ratio }),
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
    onProgress?.({ phase: 'uploading', ratio: 1 });
  }

  return {
    storage_path: ruta,
    kind: adjunto.kind,
    mime_type: adjunto.mimeType,
    file_name: adjunto.name,
    // El tamaño REAL del archivo leído, no el que informó el selector: no
    // siempre coinciden, y el que cuenta es el que se ha subido.
    bytes: local.size,
    width: adjunto.width,
    height: adjunto.height,
    duration_s: adjunto.durationS,
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
    else faltan.push(ruta);
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
  return mapa;
}

/** Se vacía al cerrar sesión: las firmas van atadas a quien las pidió. */
export function olvidarFirmasDeAdjuntos(): void {
  firmas.clear();
}
