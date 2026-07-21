import {
  embeddedProfile,
  profileHandle,
  profileName,
  toStoryItem,
  toStoryViewer,
  type StoryRow,
  type StoryViewRow,
} from '@/mappers/storyMapper';
import { supabase } from '@/services/supabase';
import { avatarPublicUrl, signMediaUrls, type UploadedMedia } from '@/services/storage';
import type { StoryGroup, StoryViewer } from '@/types';

/**
 * Historias contra Supabase (PostgREST), sin pasar por la API FastAPI.
 *
 * La API desplegada se construye desde otra rama, asi que las historias hablan
 * directamente con la base. Es seguro porque las politicas RLS de
 * 0003_stories.sql son las que mandan: solo puedes insertar historias con tu
 * propio author_id, solo borrar las tuyas, y las vistas solo las lee el autor
 * de la historia o el propio espectador.
 *
 * El modulo `apps/api/app/modules/stories` queda escrito para cuando se
 * quiera centralizar la logica en el backend.
 */

// Se nombra la FK explicitamente (`!stories_author_id_fkey`) porque hay dos
// caminos de stories a profiles —el autor y, via story_views, los espectadores—
// y sin desambiguar PostgREST responde PGRST201 (relacion ambigua).
const SELECT_STORY =
  'id, author_id, storage_path, media_type, duration_ms, caption, created_at, expires_at, author:profiles!stories_author_id_fkey(id, full_name, username, avatar_path)';

function client() {
  if (!supabase) throw new Error('Supabase no esta configurado.');
  return supabase;
}

async function currentUserId(): Promise<string | null> {
  const { data } = await client().auth.getSession();
  return data.session?.user.id ?? null;
}

export const StoryRepository = {
  /** Historias vigentes agrupadas por autor, ya con las URLs firmadas. */
  async list(): Promise<StoryGroup[]> {
    const db = client();
    const uid = await currentUserId();

    const { data, error } = await db
      .from('stories')
      .select(SELECT_STORY)
      .gt('expires_at', new Date().toISOString())
      // Cronologico dentro de cada autor: el visor avanza de vieja a nueva.
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as unknown as StoryRow[];
    if (rows.length === 0) return [];

    // Que tramos he visto ya (RLS: solo devuelve mis propias filas).
    const seen = new Set<string>();
    if (uid) {
      const { data: views } = await db
        .from('story_views')
        .select('story_id')
        .eq('viewer_id', uid)
        .in('story_id', rows.map((row) => row.id));
      (views ?? []).forEach((view: { story_id: string }) => seen.add(view.story_id));
    }

    // Contador de vistas, solo de las historias propias: es lo unico que la
    // RLS deja leer, y evita traer las visitas de todo el mundo.
    const viewsByStory = new Map<string, number>();
    if (uid) {
      const ownIds = rows.filter((row) => row.author_id === uid).map((row) => row.id);
      if (ownIds.length > 0) {
        const { data: ownViews } = await db
          .from('story_views')
          .select('story_id')
          .in('story_id', ownIds);
        (ownViews ?? []).forEach((view: { story_id: string }) => {
          viewsByStory.set(view.story_id, (viewsByStory.get(view.story_id) ?? 0) + 1);
        });
      }
    }

    const groups = new Map<string, StoryGroup>();
    rows.forEach((row) => {
      const profile = embeddedProfile(row.author);
      let group = groups.get(row.author_id);
      if (!group) {
        group = {
          authorId: row.author_id,
          author: profileName(profile),
          username: profileHandle(profile),
          avatarPath: profile?.avatar_path ?? undefined,
          avatarUrl: avatarPublicUrl(profile?.avatar_path) ?? undefined,
          items: [],
          seen: true,
          isOwn: row.author_id === uid,
        };
        groups.set(row.author_id, group);
      }
      const viewed = seen.has(row.id);
      group.items.push(toStoryItem(row, { viewed, viewsCount: viewsByStory.get(row.id) ?? 0 }));
      // Basta con que quede un tramo sin ver para que el anillo siga activo.
      if (!viewed) group.seen = false;
    });

    const ordered = [...groups.values()].sort((a, b) => {
      if (a.isOwn !== b.isOwn) return a.isOwn ? -1 : 1;
      if (a.seen !== b.seen) return a.seen ? 1 : -1;
      const lastA = a.items[a.items.length - 1]?.createdAt ?? '';
      const lastB = b.items[b.items.length - 1]?.createdAt ?? '';
      return lastB.localeCompare(lastA);
    });

    // El bucket es privado: una sola firma en lote para todos los tramos.
    const paths = ordered.flatMap((group) => group.items.map((item) => item.storagePath));
    if (paths.length > 0) {
      const urls = await signMediaUrls(paths);
      ordered.forEach((group) => {
        group.items.forEach((item) => {
          item.mediaUrl = urls[item.storagePath];
        });
      });
    }
    return ordered;
  },

  async create(
    media: UploadedMedia,
    { durationMs = 5000, caption = '' }: { durationMs?: number; caption?: string } = {},
  ): Promise<void> {
    const uid = await currentUserId();
    if (!uid) throw new Error('Inicia sesión para publicar una historia.');

    // `expires_at` lo pone la base (now() + 24 h): no se envia desde el cliente.
    const { error } = await client().from('stories').insert({
      author_id: uid,
      storage_path: media.storagePath,
      media_type: media.mediaType,
      duration_ms: durationMs,
      caption,
    });
    if (error) throw new Error(error.message);
  },

  async remove(storyId: string): Promise<void> {
    // La RLS impide borrar historias ajenas aunque llegue el id.
    const { error } = await client().from('stories').delete().eq('id', storyId);
    if (error) throw new Error(error.message);
  },

  /** Idempotente: el visor lo llama cada vez que muestra un tramo. */
  async markViewed(storyId: string): Promise<void> {
    const uid = await currentUserId();
    if (!uid) return;
    const { error } = await client()
      .from('story_views')
      .upsert(
        { story_id: storyId, viewer_id: uid },
        { onConflict: 'story_id,viewer_id', ignoreDuplicates: true },
      );
    if (error) throw new Error(error.message);
  },

  async listViewers(storyId: string): Promise<StoryViewer[]> {
    const { data, error } = await client()
      .from('story_views')
      .select('viewed_at, viewer:profiles(id, full_name, username, avatar_path)')
      .eq('story_id', storyId)
      .order('viewed_at', { ascending: false });
    if (error) throw new Error(error.message);
    return ((data ?? []) as unknown as StoryViewRow[]).map(toStoryViewer);
  },
};
