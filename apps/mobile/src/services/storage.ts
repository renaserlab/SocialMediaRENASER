import 'react-native-url-polyfill/auto';
import * as ImagePicker from 'expo-image-picker';

import { supabase } from '@/services/supabase';

const BUCKET = 'post-media';
const SIGNED_URL_TTL = 60 * 60; // 1 hora

/** Abre la galería y devuelve la imagen elegida (o null si se cancela). */
export async function pickImage(): Promise<ImagePicker.ImagePickerAsset | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return null;
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    quality: 0.8,
    allowsEditing: true,
  });
  if (result.canceled) return null;
  return result.assets[0] ?? null;
}

function randomName(ext: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now()}-${rand}.${ext}`;
}

/**
 * Sube la imagen al bucket post-media en la carpeta del usuario (uid/...),
 * como exige la política RLS. Devuelve la ruta de Storage.
 */
export async function uploadPostImage(
  asset: ImagePicker.ImagePickerAsset,
): Promise<string> {
  if (!supabase) throw new Error('Almacenamiento no disponible.');
  const { data } = await supabase.auth.getSession();
  const uid = data.session?.user?.id;
  if (!uid) throw new Error('Inicia sesión para subir imágenes.');

  const rawExt = asset.uri.split('.').pop()?.split('?')[0]?.toLowerCase();
  const ext = rawExt && rawExt.length <= 4 ? rawExt : 'jpg';
  const path = `${uid}/${randomName(ext)}`;
  const contentType = asset.mimeType ?? `image/${ext === 'jpg' ? 'jpeg' : ext}`;

  const response = await fetch(asset.uri);
  const arrayBuffer = await response.arrayBuffer();

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, arrayBuffer, { contentType, upsert: false });
  if (error) throw error;
  return path;
}

/** Firma en lote rutas de post-media para poder mostrarlas (bucket privado). */
export async function signImageUrls(
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
