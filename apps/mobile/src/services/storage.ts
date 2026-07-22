import 'react-native-url-polyfill/auto';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';

import {
  compressImage,
  compressVideo,
  compressionAvailable,
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

export type MediaKind = 'image' | 'video' | 'audio';

/** Medio elegido por el usuario, antes de subirlo. */
export type PickedMedia = {
  uri: string;
  kind: MediaKind;
  mimeType?: string | null;
  name?: string | null;
  /** Duracion en ms cuando el medio es un video (la informa el selector). */
  durationMs?: number | null;
};

/** Medio ya subido a Storage, listo para enviar al backend. */
export type UploadedMedia = {
  storagePath: string;
  mediaType: MediaKind;
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

/** Abre la galería y devuelve la imagen elegida (o null si se cancela). */
export async function pickImage(
  options: PickImageOptions = {},
): Promise<PickedMedia | null> {
  const { aspect, allowsEditing = true } = options;
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return null;
  // `MediaTypeOptions` esta deprecado en expo-image-picker 17: se usa el array.
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 0.8,
    allowsEditing,
    aspect,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  return { uri: asset.uri, kind: 'image', mimeType: asset.mimeType, name: asset.fileName };
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
  if (!permission.granted) return null;
  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ['images'],
    quality: 0.8,
    allowsEditing,
    aspect,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  return { uri: asset.uri, kind: 'image', mimeType: asset.mimeType, name: asset.fileName };
}

/** Abre la galería y devuelve el video elegido (o null si se cancela). */
export async function pickVideo(maxDurationSec = 180): Promise<PickedMedia | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return null;
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
      // Si la compresión falla no bloqueamos la publicación: sube el original.
      uri = media.uri;
    }
  }

  // Tras comprimir el contenedor es otro (mp4/jpg), asi que el nombre original
  // ya no describe la extension real: se deduce de la ruta resultante.
  const ext = resolveExtension(compressed ? { ...media, uri, name: null } : media);
  const path = `${uid}/${randomName(ext)}`;
  const contentType = resolveContentType(
    compressed ? { ...media, mimeType: null } : media,
    ext,
  );

  // Usamos Blob (no ArrayBuffer) para poder validar el tamaño antes de gastar
  // la subida y para que supabase-js conserve el content-type.
  const response = await fetch(uri);
  if (!response.ok) throw new Error('No se pudo leer el archivo seleccionado.');
  const blob = await response.blob();

  if (blob.size === 0) {
    throw new Error('El archivo seleccionado está vacío.');
  }
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `El archivo pesa ${formatMb(blob.size)} y el máximo son ${formatMb(MAX_UPLOAD_BYTES)}. Elige un video más corto o comprímelo antes de subirlo.`,
    );
  }

  onProgress?.({ phase: 'uploading', ratio: 0 });

  // 2a. Archivo grande: subida reanudable por trozos, con progreso real.
  if (blob.size > RESUMABLE_THRESHOLD && supabaseUrl) {
    const { done } = uploadResumable({
      supabaseUrl,
      accessToken: session.access_token,
      bucket: BUCKET,
      path,
      file: blob,
      contentType,
      onProgress: (ratio) => onProgress?.({ phase: 'uploading', ratio }),
    });
    try {
      await done;
    } catch (error) {
      throw new Error(describeStorageError(error));
    }
    return { storagePath: path, mediaType: media.kind };
  }

  // 2b. Archivo pequeño: un POST directo es mas simple y rapido.
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType, upsert: false });
  if (error) throw new Error(describeStorageError(error));
  onProgress?.({ phase: 'uploading', ratio: 1 });
  return { storagePath: path, mediaType: media.kind };
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

  const response = await fetch(uri);
  if (!response.ok) throw new Error('No se pudo leer la imagen seleccionada.');
  const blob = await response.blob();
  if (blob.size === 0) throw new Error('La imagen seleccionada está vacía.');

  const { error } = await supabase.storage
    .from(AVATAR_BUCKET)
    .upload(path, blob, { contentType: resolveContentType(media, ext), upsert: false });
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

  const response = await fetch(uri);
  if (!response.ok) throw new Error('No se pudo leer el archivo seleccionado.');
  const blob = await response.blob();
  if (blob.size === 0) throw new Error('El archivo seleccionado está vacío.');

  onProgress?.({ phase: 'uploading', ratio: 0 });

  // Igual que en las publicaciones: por encima del umbral, subida reanudable.
  if (blob.size > RESUMABLE_THRESHOLD && supabaseUrl) {
    const { done } = uploadResumable({
      supabaseUrl,
      accessToken: session.access_token,
      bucket: COURSE_BUCKET,
      path,
      file: blob,
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
    .upload(path, blob, { contentType, upsert: false });
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
  return map;
}

/** Se vacia al cerrar sesion: las firmas van atadas al usuario. */
export function clearSignedUrlCache(): void {
  signedUrlCache.clear();
}
