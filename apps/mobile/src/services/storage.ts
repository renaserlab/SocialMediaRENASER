import 'react-native-url-polyfill/auto';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';

import { supabase } from '@/services/supabase';

const BUCKET = 'post-media';
const SIGNED_URL_TTL = 60 * 60; // 1 hora

export type MediaKind = 'image' | 'video' | 'audio';

/** Medio elegido por el usuario, antes de subirlo. */
export type PickedMedia = {
  uri: string;
  kind: MediaKind;
  mimeType?: string | null;
  name?: string | null;
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

/** Abre la galería y devuelve la imagen elegida (o null si se cancela). */
export async function pickImage(): Promise<PickedMedia | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return null;
  // `MediaTypeOptions` esta deprecado en expo-image-picker 17: se usa el array.
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 0.8,
    allowsEditing: true,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  return { uri: asset.uri, kind: 'image', mimeType: asset.mimeType, name: asset.fileName };
}

/** Abre la galería y devuelve el video elegido (o null si se cancela). */
export async function pickVideo(): Promise<PickedMedia | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return null;
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['videos'],
    // Reduce el peso en origen: los videos de galeria pasan de 100 MB con
    // facilidad y en iOS se reexportan a 720p antes de subirlos.
    videoQuality: ImagePicker.UIImagePickerControllerQualityType.Medium,
    videoMaxDuration: 180,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  return { uri: asset.uri, kind: 'video', mimeType: asset.mimeType, name: asset.fileName };
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
  const err = error as { message?: string; statusCode?: string | number };
  const code = String(err?.statusCode ?? '');
  const message = err?.message ?? 'Error desconocido';

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
 * Sube un medio (imagen/video/audio) al bucket post-media dentro de la carpeta
 * del usuario (uid/...), como exige la política RLS. Devuelve la ruta y su tipo.
 */
export async function uploadPostMedia(media: PickedMedia): Promise<UploadedMedia> {
  if (!supabase) throw new Error('Almacenamiento no disponible.');
  const { data } = await supabase.auth.getSession();
  const uid = data.session?.user?.id;
  if (!uid) throw new Error('Inicia sesión para subir archivos.');

  const ext = resolveExtension(media);
  const path = `${uid}/${randomName(ext)}`;
  const contentType = resolveContentType(media, ext);

  // Usamos Blob (no ArrayBuffer) para poder validar el tamaño antes de gastar
  // la subida y para que supabase-js conserve el content-type.
  const response = await fetch(media.uri);
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

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType, upsert: false });
  if (error) throw new Error(describeStorageError(error));
  return { storagePath: path, mediaType: media.kind };
}

/** Firma en lote rutas de post-media para poder mostrarlas (bucket privado). */
export async function signMediaUrls(
  paths: string[],
): Promise<Record<string, string>> {
  if (!supabase || paths.length === 0) return {};
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrls(paths, SIGNED_URL_TTL);
  if (error || !data) return {};
  const map: Record<string, string> = {};
  for (const item of data) {
    if (item.path && item.signedUrl) map[item.path] = item.signedUrl;
  }
  return map;
}
