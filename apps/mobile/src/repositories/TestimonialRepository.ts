import { signMediaUrls, type UploadedMedia } from '@/services/storage';
import { supabase } from '@/services/supabase';
import type { Testimonial, TestimonialFilter } from '@/types';

/**
 * Testimonios contra Supabase (PostgREST), igual que las historias: la API
 * desplegada se construye desde otra rama.
 *
 * Quien puede publicar NO lo decide esta capa: lo decide la RLS de
 * 0008_testimonials.sql, que exige `public.is_admin()` para insertar y borrar.
 * La comprobacion de `isAdmin` en la interfaz solo sirve para no ensenar
 * botones inutiles.
 */

type TestimonialRow = {
  id: string;
  storage_path: string;
  media_type: 'image' | 'video';
  caption: string | null;
  created_at: string;
};

function client() {
  if (!supabase) throw new Error('Supabase no esta configurado.');
  return supabase;
}

export const TestimonialRepository = {
  /** Galeria completa o filtrada por tipo, con las URLs ya firmadas. */
  async list(filter: TestimonialFilter = 'all'): Promise<Testimonial[]> {
    let query = client()
      .from('testimonials')
      .select('id, storage_path, media_type, caption, created_at')
      .order('created_at', { ascending: false });
    if (filter !== 'all') query = query.eq('media_type', filter);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const items: Testimonial[] = ((data ?? []) as TestimonialRow[]).map((row) => ({
      id: row.id,
      storagePath: row.storage_path,
      mediaType: row.media_type,
      caption: row.caption ?? '',
      createdAt: row.created_at,
    }));
    if (items.length === 0) return items;

    // El bucket es privado: una sola firma en lote para toda la galeria.
    const urls = await signMediaUrls(items.map((item) => item.storagePath));
    items.forEach((item) => {
      item.mediaUrl = urls[item.storagePath];
    });
    return items;
  },

  async create(media: UploadedMedia, caption = ''): Promise<void> {
    const { data } = await client().auth.getSession();
    const uid = data.session?.user.id;
    if (!uid) throw new Error('Inicia sesión para publicar.');

    const { error } = await client().from('testimonials').insert({
      author_id: uid,
      storage_path: media.storagePath,
      media_type: media.mediaType,
      caption,
    });
    if (error) throw new Error(error.message);
  },

  /**
   * Edita un testimonio. El archivo es opcional: si no llega, solo cambia el
   * titulo y se conserva el medio original.
   */
  async update(
    id: string,
    { caption, media }: { caption: string; media?: UploadedMedia | null },
  ): Promise<void> {
    const patch: Record<string, unknown> = { caption };
    if (media) {
      patch.storage_path = media.storagePath;
      patch.media_type = media.mediaType;
    }
    // La RLS rechaza el update si quien lo pide no es administracion.
    const { error } = await client().from('testimonials').update(patch).eq('id', id);
    if (error) throw new Error(error.message);
  },

  async remove(id: string): Promise<void> {
    // La RLS rechaza el borrado si quien lo pide no es administracion.
    const { error } = await client().from('testimonials').delete().eq('id', id);
    if (error) throw new Error(error.message);
  },
};
