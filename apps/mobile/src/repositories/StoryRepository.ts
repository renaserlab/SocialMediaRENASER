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
import { apiRequest, API_V1 } from '@/services/api';
import { profileImageUrl, signMediaUrls, type UploadedMedia } from '@/services/storage';
import type { StoryGroup, StoryViewer } from '@/types';
import {
  MAX_HISTORIA_MS,
  MIN_HISTORIA_MS,
  TOPE_GUARDADO_SIN_0042_MS,
  largoDelTramo,
  type Tramo,
} from '@/lib/historias';

/**
 * Historias contra Supabase (PostgREST)... salvo cuando hay que RECORTAR.
 *
 * Leer y publicar una historia normal se hace directamente contra la base: las
 * politicas RLS de 0003_stories.sql son las que mandan (solo puedes insertar
 * historias con tu propio author_id, solo borrar las tuyas, y las vistas solo
 * las lee el autor de la historia o el propio espectador).
 *
 * PUBLICAR UN TRAMO DE UN VIDEO LARGO NO PUEDE HACERSE ASI, y por un motivo que
 * no es de estilo: PostgREST inserta una fila, no corta un video. La base solo
 * puede comprobar el NUMERO que se le manda en `duration_ms`, y ese numero lo
 * escribe el cliente. Quien puede mirar el archivo es el servidor, que tiene
 * ffmpeg desde el 27/08/2026. Por eso el recorte pasa por `POST /stories`, que
 * mide el archivo subido con ffprobe, corta el tramo y SOLO ENTONCES crea la
 * fila (ver `apps/api/app/modules/stories/recorte.py`).
 *
 * La consecuencia buena de ese orden: no existe ningun instante en el que una
 * historia con un video de cinco minutos este publicada esperando su recorte.
 * O hay tramo, o no hay historia.
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
          avatarUrl: profileImageUrl(profile?.avatar_path),
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
    {
      durationMs = 5000,
      caption = '',
      tramo,
    }: { durationMs?: number; caption?: string; tramo?: Tramo } = {},
  ): Promise<void> {
    const uid = await currentUserId();
    if (!uid) throw new Error('Inicia sesión para publicar una historia.');

    if (tramo) {
      /*
        CON RECORTE, POR LA API. Y sin respaldo contra PostgREST a proposito.

        Si la API no responde, esto falla y no se publica NADA. La tentacion
        seria caer a la insercion directa «para no perder la subida», y eso es
        exactamente el fallo que se viene a impedir: publicaria el video entero
        de cinco minutos con un `duration_ms` de treinta segundos, o sea un
        video largo disfrazado de recortado. Mejor un error claro.

        La espera es larga a proposito: el servidor tiene que leer el video,
        pasarle ffmpeg y subir el derivado. Los veinte segundos de una peticion
        normal se quedan cortos y cortarian un recorte que iba bien.

        Y es MAYOR que el presupuesto del servidor (25 s de turno + 150 s de
        recorte = 175 s, en `stories/recorte.py`). Al reves habria un hueco en
        el que la persona ve un error y la historia aparece igual un minuto
        despues. Quien mueva uno de los dos numeros tiene que mirar el otro.
      */
      await apiRequest<unknown>(`${API_V1}/stories`, {
        method: 'POST',
        timeoutMs: 180_000,
        body: JSON.stringify({
          storage_path: media.storagePath,
          media_type: media.mediaType,
          // El numero vive en `lib/historias`, no aqui: llego a estar copiado
          // en cinco sitios y con cinco copias basta cambiar cuatro.
          duration_ms: Math.max(
            MIN_HISTORIA_MS,
            Math.min(MAX_HISTORIA_MS, largoDelTramo(tramo)),
          ),
          caption,
          trim: { start_ms: tramo.inicioMs, end_ms: tramo.finMs },
        }),
      });
      return;
    }

    // `expires_at` lo pone la base (now() + 24 h): no se envia desde el cliente.
    const insertar = (duracion: number) =>
      client().from('stories').insert({
        author_id: uid,
        storage_path: media.storagePath,
        media_type: media.mediaType,
        duration_ms: duracion,
        caption,
      });

    const { error } = await insertar(durationMs);
    if (!error) return;

    /*
      MIENTRAS LA 0042 NO ESTE APLICADA, una historia de mas de quince segundos
      la rechaza la propia base: la migracion 0003 dejo
      `check (duration_ms between 1000 and 15000)` y el tope nuevo es de treinta.

      Sin esto, subir la aplicacion antes que la migracion romperia justo lo que
      se venia a arreglar: el video se sube entero y la historia falla al final
      con un error de base de datos. Asi que se reintenta UNA vez con el tope
      viejo. Lo unico que se pierde entre tanto es la barra de progreso del
      visor, que contara quince segundos en vez de los que dure el video; el
      video se ve igual y la historia se publica.

      Este bloque sobra en cuanto la 0042 este aplicada: entonces el primer
      intento no falla nunca y no llega a ejecutarse.
    */
    const esElTopeViejo =
      durationMs > TOPE_GUARDADO_SIN_0042_MS && /duration_ms/.test(error.message ?? '');
    if (!esElTopeViejo) throw new Error(error.message);

    const segundoIntento = await insertar(TOPE_GUARDADO_SIN_0042_MS);
    if (segundoIntento.error) throw new Error(segundoIntento.error.message);
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
