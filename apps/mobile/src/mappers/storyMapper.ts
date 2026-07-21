import type { StoryItem, StoryViewer } from '@/types';

/**
 * Filas tal y como las devuelve PostgREST (Supabase). Los nombres son los de
 * las columnas: el mapeo a camelCase vive aqui, como en el resto de mappers.
 */
export type ProfileRow = {
  id: string;
  full_name: string | null;
  username: string | null;
  avatar_path: string | null;
};

export type StoryRow = {
  id: string;
  author_id: string;
  storage_path: string;
  media_type: 'image' | 'video';
  duration_ms: number;
  caption: string | null;
  created_at: string;
  expires_at: string;
  /** Perfil incrustado. PostgREST puede devolverlo como objeto o como array. */
  author: ProfileRow | ProfileRow[] | null;
};

export type StoryViewRow = {
  viewed_at: string;
  viewer: ProfileRow | ProfileRow[] | null;
};

/** Normaliza el perfil incrustado, que llega como objeto o array segun el caso. */
export function embeddedProfile(value: ProfileRow | ProfileRow[] | null): ProfileRow | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

export function profileName(profile: ProfileRow | null): string {
  return profile?.full_name || profile?.username || 'Usuario';
}

export function profileHandle(profile: ProfileRow | null): string {
  if (profile?.username) return `@${profile.username}`;
  const base = profileName(profile).toLowerCase().replace(/[^a-z0-9_.]+/g, '').slice(0, 18);
  return `@${base || 'usuario'}`;
}

export function toStoryItem(
  row: StoryRow,
  { viewed, viewsCount }: { viewed: boolean; viewsCount: number },
): StoryItem {
  return {
    id: row.id,
    storagePath: row.storage_path,
    mediaType: row.media_type,
    durationMs: row.duration_ms,
    caption: row.caption ?? '',
    createdAt: row.created_at,
    viewedByMe: viewed,
    viewsCount,
  };
}

export function toStoryViewer(row: StoryViewRow): StoryViewer {
  const profile = embeddedProfile(row.viewer);
  return {
    id: profile?.id ?? '',
    fullName: profileName(profile),
    username: profileHandle(profile),
    viewedAt: row.viewed_at,
  };
}
