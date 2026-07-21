import { profileImageUrl } from '@/services/storage';
import type { UserProfile } from '@/types';

/** Forma en que el backend (FastAPI /profiles) devuelve un perfil. */
export type ProfileDto = {
  id: string;
  email: string | null;
  full_name: string;
  username: string | null;
  bio: string;
  avatar_path: string | null;
  cover_path: string | null;
  role: string;
  is_private: boolean;
  created_at: string;
  followers_count?: number;
  following_count?: number;
  posts_count?: number;
  is_following?: boolean;
};

/** Perfil compacto para listas (búsqueda). */
export type ProfileSummaryDto = {
  id: string;
  full_name: string;
  username: string | null;
  avatar_path: string | null;
  bio: string;
  is_following: boolean;
};

export type ProfileSummary = {
  id: string;
  fullName: string;
  username: string;
  avatarPath: string | null;
  bio: string;
  isFollowing: boolean;
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
    followers: dto.followers_count ?? 0,
    following: dto.following_count ?? 0,
    posts: dto.posts_count ?? 0,
    isFollowing: dto.is_following ?? false,
    // El backend guarda la ruta dentro del bucket; la vista necesita una URL.
    avatarUrl: profileImageUrl(dto.avatar_path),
    coverUrl: profileImageUrl(dto.cover_path),
  };
}

export function toProfileSummary(dto: ProfileSummaryDto): ProfileSummary {
  const handle = dto.username
    ? `@${dto.username}`
    : `@${(dto.full_name || 'usuario').toLowerCase().replace(/[^a-z0-9_.]+/g, '').slice(0, 18) || 'usuario'}`;
  return {
    id: dto.id,
    fullName: dto.full_name || 'Usuario',
    username: handle,
    avatarPath: dto.avatar_path,
    bio: dto.bio ?? '',
    isFollowing: dto.is_following,
  };
}

/** Convierte cambios del modelo de vista al payload que espera el backend. */
/**
 * Cambios admitidos sobre el perfil propio. Las imagenes viajan como RUTA del
 * bucket; `null` significa quitarla (el backend lo recibe como cadena vacia).
 */
export type ProfileUpdatePatch = Partial<
  Pick<UserProfile, 'fullName' | 'username' | 'bio'>
> & {
  avatarPath?: string | null;
  coverPath?: string | null;
};

export function toProfileUpdatePayload(patch: ProfileUpdatePatch): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (patch.fullName !== undefined) payload.full_name = patch.fullName;
  if (patch.username !== undefined) payload.username = patch.username.replace(/^@/, '');
  if (patch.bio !== undefined) payload.bio = patch.bio;
  // Cadena vacia = borrar. `undefined` deja el campo intacto (exclude_unset).
  if (patch.avatarPath !== undefined) payload.avatar_path = patch.avatarPath ?? '';
  if (patch.coverPath !== undefined) payload.cover_path = patch.coverPath ?? '';
  return payload;
}
