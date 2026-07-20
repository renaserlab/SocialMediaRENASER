import type { UserProfile } from '@/types';

/** Forma en que el backend (FastAPI /profiles) devuelve un perfil. */
export type ProfileDto = {
  id: string;
  email: string | null;
  full_name: string;
  username: string | null;
  bio: string;
  avatar_path: string | null;
  role: string;
  is_private: boolean;
  created_at: string;
};

function deriveUsername(dto: ProfileDto): string {
  if (dto.username) return `@${dto.username}`;
  const base = (dto.email?.split('@')[0] ?? dto.full_name ?? 'usuario')
    .toLowerCase()
    .replace(/[^a-z0-9_.]+/g, '')
    .slice(0, 18);
  return `@${base || 'usuario'}`;
}

/**
 * Adapta el perfil del backend al modelo que consumen las vistas (UserProfile).
 * Los contadores sociales (followers/following/posts) llegaran del backend en
 * fases posteriores (social graph); por ahora quedan en 0 para no romper la UI.
 */
export function toUserProfile(dto: ProfileDto): UserProfile {
  return {
    id: dto.id,
    fullName: dto.full_name || (dto.email?.split('@')[0] ?? 'Usuario'),
    username: deriveUsername(dto),
    email: dto.email ?? '',
    bio: dto.bio ?? '',
    followers: 0,
    following: 0,
    posts: 0,
  };
}

/** Convierte cambios del modelo de vista al payload que espera el backend. */
export function toProfileUpdatePayload(
  patch: Partial<Pick<UserProfile, 'fullName' | 'username' | 'bio'>>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (patch.fullName !== undefined) payload.full_name = patch.fullName;
  if (patch.username !== undefined) payload.username = patch.username.replace(/^@/, '');
  if (patch.bio !== undefined) payload.bio = patch.bio;
  return payload;
}
