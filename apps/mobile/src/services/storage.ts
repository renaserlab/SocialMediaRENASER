import 'react-native-url-polyfill/auto';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { olvidarInstantaneaDeVideos } from '@/feed/cacheDeVideos';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

import {
  compressImage,
  compressVideo,
  compressionAvailable,
  createVideoPoster,
  readVideoMetadata,
} from '@/services/mediaCompressor';
import { uploadResumable } from '@/services/resumableUpload';
import { supabase, supabaseUrl } from '@/services/supabase';

const BUCKET = 'post-media';
const SIGNED_URL_TTL = 60 * 60; // 1 hora

/**
 * Cache de URLs firmadas.
 *
 * Cada llamada a `createSignedUrls` devuelve una firma DISTINTA para el mismo
 * archivo, asi que la URL cambiaba en cada carga del feed y la imagen nunca se
 * reutilizaba de la cache del sistema: se descargaba entera otra vez.
 * Reutilizando la firma mientras siga vigente, volver a una pantalla ya vista
 * es inmediato. Se renueva 10 min antes de caducar para no servir un enlace
 * muerto.
 */
const CACHE_TTL_MS = (SIGNED_URL_TTL - 600) * 1000;
const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();

/*
  La cache de firmas SOBREVIVE al cierre de la aplicacion.

  Solo en memoria, cada arranque partia de cero: se volvia a firmar todo y,
  como cada firma produce una URL DISTINTA, la cache de disco de expo-image no
  reconocia ninguna imagen y el muro entero se descargaba otra vez en cada
  apertura (medido: el feed actual son varios MB de fotos). Guardando las
  firmas vigentes, al reabrir dentro de la hora la URL es la misma, no hay
  peticion de firma y las imagenes salen del disco al instante.

  Se guarda solo el mapa ruta→{url, caducidad}: unos pocos KB.
*/
const SIGNED_CACHE_STORAGE_KEY = 'z-signed-urls-v1';

let signedCacheReady: Promise<void> | null = null;

function ensureSignedCacheLoaded(): Promise<void> {
  if (!signedCacheReady) {
    signedCacheReady = AsyncStorage.getItem(SIGNED_CACHE_STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        const now = Date.now();
        const saved = JSON.parse(raw) as Record<string, { url: string; expiresAt: number }>;
        for (const [path, entry] of Object.entries(saved)) {
          // Las caducadas no se restauran; se refirmaran al pedirse.
          if (entry?.url && entry.expiresAt > now && !signedUrlCache.has(path)) {
            signedUrlCache.set(path, entry);
          }
        }
      })
      .catch(() => {
        // Una cache ilegible no es un error: se firma de nuevo y listo.
      });
  }
  return signedCacheReady;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Persiste la cache con un pequeño retraso para agrupar rafagas de firmas. */
function scheduleSignedCacheSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const out: Record<string, { url: string; expiresAt: number }> = {};
    const now = Date.now();
    for (const [path, entry] of signedUrlCache) {
      if (entry.expiresAt > now) out[path] = entry;
    }
    AsyncStorage.setItem(SIGNED_CACHE_STORAGE_KEY, JSON.stringify(out)).catch(() => {});
  }, 500);
}

export type MediaKind = 'image' | 'video' | 'audio';

/** Medio elegido por el usuario, antes de subirlo. */
export type PickedMedia = {
  uri: string;
  kind: MediaKind;
  mimeType?: string | null;
  name?: string | null;
  /** Duracion en ms cuando el medio es un video (la informa el selector). */
  durationMs?: number | null;
  /** Medidas que informa el selector; sirven para la proporcion del hueco. */
  width?: number | null;
  height?: number | null;
};

/** Medio ya subido a Storage, listo para enviar al backend. */
export type UploadedMedia = {
  storagePath: string;
  mediaType: MediaKind;
  /*
    Metadata que viaja al backend junto a la ruta. Con ella la tarjeta reserva
    el hueco exacto (sin saltos de layout) y el poster se pinta al instante
    mientras el video prepara. Todo opcional: donde no se pueda calcular
    (Expo Go sin modulo nativo), el post funciona igual que antes.
  */
  width?: number;
  height?: number;
  durationS?: number;
  bytes?: number;
  /** Ruta del poster ya subido a Storage (solo videos, cuando se pudo). */
  posterPath?: string;
};

const DEFAULT_EXT: Record<MediaKind, string> = {
  image: 'jpg',
  video: 'mp4',
  audio: 'm4a',
};

// --------------------------------------------------------------------------
// Selección
// --------------------------------------------------------------------------

export type PickImageOptions = {
  /** Proporción del recorte. Solo la respeta Android. */
  aspect?: [number, number];
  /**
   * Recorte antes de subir. Debe ir a `false` para banners: con `true`, iOS
   * fuerza un recorte CUADRADO y una portada apaisada pierde los bordes.
   */
  allowsEditing?: boolean;
};

/**
 * El permiso de fotos o de camara esta denegado.
 *
 * Se lanza en vez de devolver `null` porque `null` significa "la persona
 * cancelo", y confundir ambos casos dejaba el boton sin hacer NADA: ni foto ni
 * explicacion. En iOS el sistema solo pregunta UNA vez, asi que si se rechazo
 * en su dia, todas las llamadas siguientes fallan calladas para siempre y la
 * unica salida es activarlo a mano en los ajustes del telefono.
 */
export class PermisoDenegadoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermisoDenegadoError';
  }
}

const AVISO_FOTOS =
  'Z no tiene permiso para acceder a tus fotos. Actívalo en Ajustes del ' +
  'teléfono → Z → Fotos.';
const AVISO_CAMARA =
  'Z no tiene permiso para usar la cámara. Actívalo en Ajustes del ' +
  'teléfono → Z → Cámara.';

/**
 * `aspect` solo se envia en Android.
 *
 * iOS lo ignora —su recorte siempre es cuadrado— pero ademas pasarlo impedia
 * que el selector llegara a abrirse: los sitios que lo enviaban (historias,
 * foto de perfil) no hacian nada al tocarlos, mientras que crear una
 * publicacion, que no lo envia, funcionaba. Como en iOS no aportaba nada, se
 * omite en vez de arrastrar el problema.
 */
function aspectoPorPlataforma(
  aspect: [number, number] | undefined,
): { aspect?: [number, number] } {
  if (Platform.OS !== 'android' || !aspect) return {};
  return { aspect };
}

/** Abre la galería y devuelve la imagen elegida (o null si se cancela). */
export async function pickImage(
  options: PickImageOptions = {},
): Promise<PickedMedia | null> {
  const { aspect, allowsEditing = true } = options;
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) throw new PermisoDenegadoError(AVISO_FOTOS);
  // `MediaTypeOptions` esta deprecado en expo-image-picker 17: se usa el array.
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 0.8,
    allowsEditing,
    ...aspectoPorPlataforma(aspect),
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  return {
    uri: asset.uri,
    kind: 'image',
    mimeType: asset.mimeType,
    name: asset.fileName,
    width: asset.width ?? null,
    height: asset.height ?? null,
  };
}

/**
 * Abre la cámara y devuelve la foto tomada (o null si se cancela).
 *
 * `aspect` solo lo respeta Android; en iOS el recorte siempre es cuadrado.
 */
export async function takePhoto(
  options: PickImageOptions = {},
): Promise<PickedMedia | null> {
  const { aspect, allowsEditing = true } = options;
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) throw new PermisoDenegadoError(AVISO_CAMARA);
  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ['images'],
    quality: 0.8,
    allowsEditing,
    ...aspectoPorPlataforma(aspect),
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  return {
    uri: asset.uri,
    kind: 'image',
    mimeType: asset.mimeType,
    name: asset.fileName,
    width: asset.width ?? null,
    height: asset.height ?? null,
  };
}

/** Abre la galería y devuelve el video elegido (o null si se cancela). */
export async function pickVideo(maxDurationSec = 180): Promise<PickedMedia | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) throw new PermisoDenegadoError(AVISO_FOTOS);
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['videos'],
    // Reduce el peso en origen: los videos de galeria pasan de 100 MB con
    // facilidad y en iOS se reexportan a 720p antes de subirlos.
    videoQuality: ImagePicker.UIImagePickerControllerQualityType.Medium,
    // OJO: solo limita la grabacion con camara. Al elegir de la galeria hay que
    // comprobar `durationMs` en quien llama.
    videoMaxDuration: maxDurationSec,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  return {
    uri: asset.uri,
    kind: 'video',
    mimeType: asset.mimeType,
    name: asset.fileName,
    durationMs: asset.duration ?? null,
    width: asset.width ?? null,
    height: asset.height ?? null,
  };
}

/** Abre el selector de archivos para elegir un audio. */
export async function pickAudio(): Promise<PickedMedia | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'audio/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets?.[0];
  if (!asset) return null;
  return { uri: asset.uri, kind: 'audio', mimeType: asset.mimeType, name: asset.name };
}

// --------------------------------------------------------------------------
// Subida
// --------------------------------------------------------------------------

function randomName(ext: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now()}-${rand}.${ext}`;
}

function resolveExtension(media: PickedMedia): string {
  const fromName = media.name?.split('.').pop()?.toLowerCase();
  if (fromName && fromName.length <= 5 && /^[a-z0-9]+$/.test(fromName)) return fromName;
  const fromUri = media.uri.split('?')[0]?.split('.').pop()?.toLowerCase();
  if (fromUri && fromUri.length <= 5 && /^[a-z0-9]+$/.test(fromUri)) return fromUri;
  return DEFAULT_EXT[media.kind];
}

function resolveContentType(media: PickedMedia, ext: string): string {
  if (media.mimeType) return media.mimeType;
  if (media.kind === 'image') return `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  if (media.kind === 'video') return `video/${ext}`;
  return `audio/${ext === 'm4a' ? 'mp4' : ext}`;
}

/**
 * Límite por archivo, en MB. Debe coincidir con el limite real del proyecto
 * Supabase (Storage → Settings → Upload file size limit) y con el del bucket:
 * el plan free tope a 50 MB, el Pro admite hasta 50 GB. Esta comprobacion es
 * solo para fallar rapido y con un mensaje claro; quien manda es el servidor.
 */
const MAX_UPLOAD_MB = Number(process.env.EXPO_PUBLIC_MAX_UPLOAD_MB ?? 500);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

/**
 * Tope para un video que NO ha pasado por el compresor.
 *
 * El compresor deja un video de movil en 10-20 MB y, de paso, coloca el indice
 * del archivo al principio, que es lo que permite empezar a verlo enseguida en
 * vez de esperar. Cuando no esta disponible —en Expo Go o en la web— el video
 * viaja tal cual, y ahi es donde se colaron los que hay hoy: hasta 161 MB para
 * menos de dos minutos, a una velocidad que ninguna conexion movil sostiene y
 * gastando 89 MB de datos por cada minuto visto a quien lo mira.
 *
 * Sesenta megas es holgado para un video corto ya comprimido y corta en seco
 * los originales de camara sin tocar. Solo se aplica cuando no se ha podido
 * comprimir: si el compresor hizo su trabajo, manda el limite general.
 */
const MAX_VIDEO_SIN_COMPRIMIR_BYTES = 60 * 1024 * 1024;

function formatMb(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

/**
 * Traduce un error de Storage a algo accionable.
 *
 * Storage responde SIEMPRE con HTTP 400 y mete el codigo real en el cuerpo
 * (`statusCode`), asi que sin esto en consola solo se ve "400 (Bad Request)".
 */
function describeStorageError(error: unknown): string {
  const err = error as {
    message?: string;
    statusCode?: string | number;
    // tus-js-client adjunta la respuesta HTTP que provoco el fallo.
    originalResponse?: { getStatus?: () => number };
  };
  const code = String(err?.statusCode ?? err?.originalResponse?.getStatus?.() ?? '');
  const message = err?.message ?? 'Error desconocido';

  if (/network|failed to fetch|timeout/i.test(message)) {
    return 'Se perdió la conexión durante la subida. Vuelve a intentarlo: se reanudará donde se quedó.';
  }

  if (code === '413' || /exceeded the maximum allowed size|too large/i.test(message)) {
    // El servidor lo rechaza aunque pase el chequeo local: el limite del
    // proyecto/bucket en Supabase es menor que EXPO_PUBLIC_MAX_UPLOAD_MB.
    return `Supabase rechazó el archivo por tamaño. Sube el límite en Storage → Settings → Upload file size limit (y en el bucket post-media).`;
  }
  if (code === '403' || /unauthorized|row-level security|violates/i.test(message)) {
    return 'No tienes permiso para subir este archivo. Cierra sesión y vuelve a entrar.';
  }
  if (code === '409' || /already exists/i.test(message)) {
    return 'Ya existe un archivo con ese nombre. Inténtalo de nuevo.';
  }
  if (/mime|content-type/i.test(message)) {
    return `El bucket no acepta este tipo de archivo (${message}).`;
  }
  return `Storage rechazó el archivo: ${message}${code ? ` (código ${code})` : ''}`;
}

/**
 * A partir de este tamaño se usa subida reanudable (TUS) en vez de un POST
 * unico. Es el umbral que recomienda Supabase.
 */
const RESUMABLE_THRESHOLD = 6 * 1024 * 1024;

/** Archivo local ya leido, listo para subir por cualquiera de las dos vias. */
type LocalFile = {
  /** Tamaño real en bytes. */
  size: number;
  /** Cuerpo para el POST directo de supabase-js. */
  directBody: () => Promise<Blob | ArrayBuffer>;
  /** Cuerpo (Blob) para la subida reanudable por trozos (TUS). */
  resumableBody: () => Promise<Blob>;
};

/**
 * Prepara un archivo local para subirlo, leyendo su tamaño y sus bytes.
 *
 * El motivo de que exista: en React Native, `fetch(uri).blob()` devuelve un
 * Blob que informa bien su `size`, pero cuyo cuerpo viaja VACIO cuando
 * supabase-js lo envia en el POST. Una foto tomada desde el iPhone se subia
 * como 0 bytes y, claro, no se veia. Solo afectaba a los archivos por debajo
 * del umbral reanudable: los grandes van por TUS, que recorre el Blob por
 * trozos y si transmite el contenido.
 *
 * En nativo se leen los bytes reales con expo-file-system (`File.arrayBuffer`),
 * que supabase-js sube correctamente. En web el Blob funciona y se conserva tal
 * cual, sin cargar nada extra en memoria.
 */
async function readLocalFile(uri: string): Promise<LocalFile> {
  if (Platform.OS === 'web') {
    const response = await fetch(uri);
    if (!response.ok) throw new Error('No se pudo leer el archivo seleccionado.');
    const blob = await response.blob();
    return {
      size: blob.size,
      directBody: async () => blob,
      resumableBody: async () => blob,
    };
  }
  // El tamaño se obtiene sin cargar el archivo entero en memoria.
  const file = new File(uri);
  return {
    size: file.size ?? 0,
    directBody: () => file.arrayBuffer(),
    // TUS lee el Blob por trozos; ahi el contenido si viaja bien en RN.
    resumableBody: async () => (await fetch(uri)).blob(),
  };
}

export type UploadPhase = 'compressing' | 'uploading';

export type UploadProgress = {
  phase: UploadPhase;
  /** Avance de 0 a 1. */
  ratio: number;
};

/**
 * Sube un medio (imagen/video/audio) al bucket post-media dentro de la carpeta
 * del usuario (uid/...), como exige la política RLS. Devuelve la ruta y su tipo.
 *
 * Antes comprime en el dispositivo y, si el archivo sigue siendo grande, lo
 * sube por trozos reanudables para sobrevivir a cortes de red.
 */
export async function uploadPostMedia(
  media: PickedMedia,
  onProgress?: (progress: UploadProgress) => void,
): Promise<UploadedMedia> {
  if (!supabase) throw new Error('Almacenamiento no disponible.');
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  const uid = session?.user?.id;
  if (!session || !uid) throw new Error('Inicia sesión para subir archivos.');

  // 1. Compresión en el dispositivo (no-op en web). Un video de galeria de
  //    100 MB suele bajar a 10-20 MB, que es lo que hace que subir por datos
  //    moviles sea viable.
  let uri = media.uri;
  let compressed = false;
  if (compressionAvailable && (media.kind === 'video' || media.kind === 'image')) {
    try {
      onProgress?.({ phase: 'compressing', ratio: 0 });
      uri =
        media.kind === 'video'
          ? await compressVideo(media.uri, (ratio) =>
              onProgress?.({ phase: 'compressing', ratio }),
            )
          : await compressImage(media.uri);
      compressed = uri !== media.uri;
    } catch {
      // Si la compresión falla no bloqueamos la publicación: sube el original,
      // pero mas abajo se comprueba que no sea desmesurado.
      uri = media.uri;
    }
  }

  /*
    Un video que no ha pasado por el compresor viaja con el tamaño original y
    con el indice al final del archivo. Se marca aqui para poder exigirle un
    tope mas estricto: hasta ahora subia en silencio y el problema no aparecia
    hasta que alguien intentaba verlo.
  */
  const videoSinComprimir = media.kind === 'video' && !compressed;

  // Tras comprimir el contenedor es otro (mp4/jpg), asi que el nombre original
  // ya no describe la extension real: se deduce de la ruta resultante.
  const ext = resolveExtension(compressed ? { ...media, uri, name: null } : media);
  const path = `${uid}/${randomName(ext)}`;
  const contentType = resolveContentType(
    compressed ? { ...media, mimeType: null } : media,
    ext,
  );

  const local = await readLocalFile(uri);

  if (local.size === 0) {
    throw new Error('El archivo seleccionado está vacío.');
  }
  if (local.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `El archivo pesa ${formatMb(local.size)} y el máximo son ${formatMb(MAX_UPLOAD_BYTES)}. Elige un video más corto o comprímelo antes de subirlo.`,
    );
  }
  if (videoSinComprimir && local.size > MAX_VIDEO_SIN_COMPRIMIR_BYTES) {
    throw new Error(
      `Este vídeo pesa ${formatMb(local.size)} y no se ha podido comprimir en este dispositivo. ` +
        `Súbelo desde la aplicación instalada, o elige uno de menos de ${formatMb(MAX_VIDEO_SIN_COMPRIMIR_BYTES)}: ` +
        'a ese tamaño tardaría demasiado en cargar y consumiría muchos datos a quien lo vea.',
    );
  }

  /*
    Metadata y poster ANTES de subir, con el archivo definitivo (el comprimido
    si lo hubo). Ninguno es imprescindible: si algo falla, el post sale igual
    que salia antes y el pipeline del backend puede completarlo despues.
  */
  const meta: Pick<UploadedMedia, 'width' | 'height' | 'durationS' | 'bytes'> = {
    bytes: local.size,
  };
  let posterPath: string | undefined;
  if (media.kind === 'video') {
    const fromFile = await readVideoMetadata(uri).catch(() => null);
    meta.width = fromFile?.width ?? media.width ?? undefined;
    meta.height = fromFile?.height ?? media.height ?? undefined;
    meta.durationS =
      fromFile?.durationS ?? (media.durationMs ? media.durationMs / 1000 : undefined);

    // El poster es la diferencia entre un rectangulo negro y ver de que va el
    // video sin descargar ni un byte de el.
    try {
      const poster = await createVideoPoster(uri);
      if (poster) {
        const posterLocal = await readLocalFile(poster.uri);
        if (posterLocal.size > 0) {
          const candidate = `${uid}/poster-${randomName('jpg')}`;
          const { error: posterError } = await supabase.storage
            .from(BUCKET)
            .upload(candidate, await posterLocal.directBody(), {
              contentType: 'image/jpeg',
              upsert: false,
            });
          if (!posterError) {
            posterPath = candidate;
            meta.width = meta.width ?? poster.width;
            meta.height = meta.height ?? poster.height;
          }
        }
      }
    } catch {
      // Sin poster: el muro pinta su celda generica, como hasta ahora.
    }
  } else if (media.kind === 'image') {
    // El compresor reescala en proporcion, asi que las medidas del selector
    // valen para reservar el hueco aunque el archivo subido sea mas pequeno.
    meta.width = media.width ?? undefined;
    meta.height = media.height ?? undefined;
  }

  onProgress?.({ phase: 'uploading', ratio: 0 });

  // 2a. Archivo grande: subida reanudable por trozos, con progreso real.
  if (local.size > RESUMABLE_THRESHOLD && supabaseUrl) {
    const { done } = uploadResumable({
      supabaseUrl,
      accessToken: session.access_token,
      bucket: BUCKET,
      path,
      file: await local.resumableBody(),
      contentType,
      onProgress: (ratio) => onProgress?.({ phase: 'uploading', ratio }),
    });
    try {
      await done;
    } catch (error) {
      throw new Error(describeStorageError(error));
    }
    return { storagePath: path, mediaType: media.kind, ...meta, posterPath };
  }

  // 2b. Archivo pequeño: un POST directo es mas simple y rapido.
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, await local.directBody(), { contentType, upsert: false });
  if (error) throw new Error(describeStorageError(error));
  onProgress?.({ phase: 'uploading', ratio: 1 });
  return { storagePath: path, mediaType: media.kind, ...meta, posterPath };
}

// --------------------------------------------------------------------------
// Fotos de perfil y portada
// --------------------------------------------------------------------------

const AVATAR_BUCKET = 'avatars';

/**
 * URL publica de una ruta del bucket `avatars` (avatar o portada).
 *
 * El bucket es publico, asi que no hace falta firmar y la URL no caduca, algo
 * importante porque la foto de perfil se pinta en cada tarjeta del feed.
 * Devuelve undefined cuando no hay foto, para que la vista use el placeholder.
 */
export function profileImageUrl(path: string | null | undefined): string | undefined {
  if (!supabase || !path) return undefined;
  return supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path).data.publicUrl;
}

/**
 * Sube la foto de perfil o portada al bucket `avatars` y devuelve su RUTA.
 *
 * Se guarda la ruta (no la URL) porque es lo que persiste el backend: asi el
 * bucket puede pasar a privado sin reescribir la base de datos. La carpeta debe
 * empezar por el uid, que es lo que exige la politica RLS.
 */
export async function uploadProfileImage(
  kind: 'avatar' | 'cover',
  media: PickedMedia,
): Promise<string> {
  if (!supabase) throw new Error('Almacenamiento no disponible.');
  const { data } = await supabase.auth.getSession();
  const uid = data.session?.user?.id;
  if (!uid) throw new Error('Inicia sesión para cambiar tus fotos.');

  // Una foto de perfil no necesita la resolucion original de la camara.
  let uri = media.uri;
  if (compressionAvailable) {
    try {
      uri = await compressImage(media.uri);
    } catch {
      uri = media.uri;
    }
  }

  const ext = resolveExtension({ ...media, uri, name: null });
  const path = `${uid}/${kind}-${randomName(ext)}`;

  const local = await readLocalFile(uri);
  if (local.size === 0) throw new Error('La imagen seleccionada está vacía.');

  const { error } = await supabase.storage
    .from(AVATAR_BUCKET)
    .upload(path, await local.directBody(), {
      contentType: resolveContentType(media, ext),
      upsert: false,
    });
  if (error) throw new Error(describeStorageError(error));
  return path;
}

/** Firma en lote rutas de post-media para poder mostrarlas (bucket privado). */
const COURSE_BUCKET = 'course-media';

/**
 * Sube el video (o material) de una leccion y devuelve su RUTA.
 *
 * Va al bucket `course-media`, no a `post-media`: admite 2 GB por archivo
 * (0004_storage_limits) y sus politicas solo dejan escribir a la
 * administracion. Se guarda la ruta, no la URL, porque el bucket es privado y
 * las firmas caducan.
 */
export async function uploadCourseMedia(
  media: PickedMedia,
  onProgress?: (progress: UploadProgress) => void,
): Promise<string> {
  if (!supabase) throw new Error('Almacenamiento no disponible.');
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  const uid = session?.user?.id;
  if (!session || !uid) throw new Error('Inicia sesión para subir el contenido.');

  let uri = media.uri;
  if (compressionAvailable && media.kind === 'video') {
    try {
      onProgress?.({ phase: 'compressing', ratio: 0 });
      uri = await compressVideo(media.uri, (ratio) =>
        onProgress?.({ phase: 'compressing', ratio }),
      );
    } catch {
      uri = media.uri;
    }
  }

  const ext = resolveExtension({ ...media, uri, name: null });
  const path = `${uid}/${randomName(ext)}`;
  const contentType = resolveContentType({ ...media, mimeType: null }, ext);

  const local = await readLocalFile(uri);
  if (local.size === 0) throw new Error('El archivo seleccionado está vacío.');

  onProgress?.({ phase: 'uploading', ratio: 0 });

  // Igual que en las publicaciones: por encima del umbral, subida reanudable.
  if (local.size > RESUMABLE_THRESHOLD && supabaseUrl) {
    const { done } = uploadResumable({
      supabaseUrl,
      accessToken: session.access_token,
      bucket: COURSE_BUCKET,
      path,
      file: await local.resumableBody(),
      contentType,
      onProgress: (ratio) => onProgress?.({ phase: 'uploading', ratio }),
    });
    try {
      await done;
    } catch (error) {
      throw new Error(describeStorageError(error));
    }
    return path;
  }

  const { error } = await supabase.storage
    .from(COURSE_BUCKET)
    .upload(path, await local.directBody(), { contentType, upsert: false });
  if (error) throw new Error(describeStorageError(error));
  onProgress?.({ phase: 'uploading', ratio: 1 });
  return path;
}

/** Firma rutas del bucket `course-media` (privado, como post-media). */
export async function signCourseUrls(paths: string[]): Promise<Record<string, string>> {
  if (!supabase || paths.length === 0) return {};
  const { data, error } = await supabase.storage
    .from(COURSE_BUCKET)
    .createSignedUrls(paths, SIGNED_URL_TTL);
  if (error || !data) return {};
  const map: Record<string, string> = {};
  for (const item of data) {
    if (item.path && item.signedUrl) map[item.path] = item.signedUrl;
  }
  return map;
}

export async function signMediaUrls(
  paths: string[],
): Promise<Record<string, string>> {
  if (!supabase || paths.length === 0) return {};

  // Las firmas guardadas del arranque anterior cuentan como cache valida.
  await ensureSignedCacheLoaded();

  // Solo se piden las que no estan en cache o estan a punto de caducar.
  const now = Date.now();
  const map: Record<string, string> = {};
  const missing: string[] = [];
  for (const path of paths) {
    const hit = signedUrlCache.get(path);
    if (hit && hit.expiresAt > now) map[path] = hit.url;
    else missing.push(path);
  }
  if (missing.length === 0) return map;

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrls(missing, SIGNED_URL_TTL);
  if (error || !data) return map;
  const expiresAt = now + CACHE_TTL_MS;
  for (const item of data) {
    if (item.path && item.signedUrl) {
      map[item.path] = item.signedUrl;
      signedUrlCache.set(item.path, { url: item.signedUrl, expiresAt });
    }
  }
  scheduleSignedCacheSave();
  return map;
}

/** Se vacia al cerrar sesion: las firmas van atadas al usuario. */
export function clearSignedUrlCache(): void {
  signedUrlCache.clear();
  AsyncStorage.removeItem(SIGNED_CACHE_STORAGE_KEY).catch(() => {});
  // La instantanea del Inicio tambien: el contenido guardado es de quien lo
  // vio, y quedaria visible para la siguiente persona que entrara sin red.
  void olvidarInstantaneaDeVideos();
}
