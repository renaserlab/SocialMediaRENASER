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

/**
 * Abre la galería y devuelve la imagen elegida (o null si se cancela).
 *
 * `aspect` solo lo respeta Android; en iOS el recorte siempre es cuadrado.
 */
export async function pickImage(aspect?: [number, number]): Promise<PickedMedia | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return null;
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    quality: 0.8,
    allowsEditing: true,
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
export async function takePhoto(aspect?: [number, number]): Promise<PickedMedia | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) return null;
  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    quality: 0.8,
    allowsEditing: true,
    aspect,
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
    mediaTypes: ImagePicker.MediaTypeOptions.Videos,
    quality: 0.8,
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

  const response = await fetch(media.uri);
  const arrayBuffer = await response.arrayBuffer();

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, arrayBuffer, { contentType, upsert: false });
  if (error) throw error;
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
