import { apiRequest, API_V1 } from '@/services/api';
import {
  FeaturedMember,
  FeaturedProfileDto,
  ProfileDto,
  ProfileSummary,
  ProfileSummaryDto,
  ProfileUpdatePatch,
  toFeaturedMember,
  toProfileSummary,
  toProfileUpdatePayload,
  toUserProfile,
} from '@/mappers/profileMapper';
import type { UserProfile } from '@/types';

/**
 * Acceso al perfil a traves del backend FastAPI. La identidad la resuelve el
 * backend desde el JWT (no se envia ningun id de usuario).
 */
export const ProfileRepository = {
  async getMyProfile(): Promise<UserProfile> {
    const dto = await apiRequest<ProfileDto>(`${API_V1}/profiles/me`);
    return toUserProfile(dto);
  },

  async updateMyProfile(patch: ProfileUpdatePatch): Promise<UserProfile> {
    const dto = await apiRequest<ProfileDto>(`${API_V1}/profiles/me`, {
      method: 'PATCH',
      body: JSON.stringify(toProfileUpdatePayload(patch)),
    });
    return toUserProfile(dto);
  },

  /** Perfiles sugeridos al registrarse, para que el feed no empiece vacío. */
  async listFeatured(): Promise<FeaturedMember[]> {
    const dtos = await apiRequest<FeaturedProfileDto[]>(`${API_V1}/profiles/featured`);
    return dtos.map(toFeaturedMember);
  },

  async getById(profileId: string): Promise<UserProfile> {
    const dto = await apiRequest<ProfileDto>(`${API_V1}/profiles/${profileId}`);
    return toUserProfile(dto);
  },

  async search(query: string): Promise<ProfileSummary[]> {
    const dtos = await apiRequest<ProfileSummaryDto[]>(
      `${API_V1}/profiles/search?q=${encodeURIComponent(query)}`,
    );
    return dtos.map(toProfileSummary);
  },

  async follow(profileId: string): Promise<number> {
    const res = await apiRequest<{ following: boolean; followers_count: number }>(
      `${API_V1}/profiles/${profileId}/follow`,
      { method: 'POST' },
    );
    return res.followers_count;
  },

  async unfollow(profileId: string): Promise<number> {
    const res = await apiRequest<{ following: boolean; followers_count: number }>(
      `${API_V1}/profiles/${profileId}/follow`,
      { method: 'DELETE' },
    );
    return res.followers_count;
  },
};
