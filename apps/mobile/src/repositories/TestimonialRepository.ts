import { signMediaUrls, type UploadedMedia } from '@/services/storage';
import { supabase } from '@/services/supabase';
import type { Testimonial, TestimonialFilter } from '@/types';

/**
 * La GALERIA de fotos y videos de un perfil, contra Supabase (PostgREST).
 *
 * ESTO NO SON RESEÑAS, aunque se llamaran asi durante un tiempo. La tabla
 * `testimonials` guarda lo que publica UN autor: archivo obligatorio, texto
 * opcional y ninguna columna que diga sobre QUIEN se opina. Por eso `list`
 * filtra por `author_id`: ensena lo que esa persona SUBIO, nunca lo que le
 * dijeron. Se conserva tal cual porque tiene contenido real.
 *
 * Para opinar sobre otra persona esta `ReviewRepository`, que habla con el
 * backend (`/api/v1/reviews`) y escribe en `profile_reviews` (migracion 0030).
 *
 * Quien puede publicar aqui NO lo decide esta capa: lo decide la RLS. La 0008
 * exigia `public.is_admin()` para insertar, editar y borrar, y la 0017 lo abrio
 * a cualquiera EN SU PROPIO NOMBRE (`author_id = auth.uid()`), dejando la
 * administracion con paso franco para moderar. Si en alguna base la 0017 no
 * estuviera aplicada, el insert lo seguiria rechazando la base.
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
  /**
   * Galeria de un perfil, con las URLs ya firmadas.
   *
   * `authorId` es obligatorio en la practica: sin el, la consulta devolvia
   * TODOS los testimonios, asi que los de la cuenta administradora aparecian
   * dentro del perfil de cualquier otra persona.
   */
  async list(
    filter: TestimonialFilter = 'all',
    authorId?: string,
  ): Promise<Testimonial[]> {
    let query = client()
      .from('testimonials')
      .select('id, storage_path, media_type, caption, created_at')
      .order('created_at', { ascending: false });
    if (authorId) query = query.eq('author_id', authorId);
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
