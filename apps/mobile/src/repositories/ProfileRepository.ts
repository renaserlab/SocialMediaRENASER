import { apiRequest, API_V1 } from '@/services/api';
import { ProfileDto, toProfileUpdatePayload, toUserProfile } from '@/mappers/profileMapper';
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

  async updateMyProfile(
    patch: Partial<Pick<UserProfile, 'fullName' | 'username' | 'bio'>>,
  ): Promise<UserProfile> {
    const dto = await apiRequest<ProfileDto>(`${API_V1}/profiles/me`, {
      method: 'PATCH',
      body: JSON.stringify(toProfileUpdatePayload(patch)),
    });
    return toUserProfile(dto);
  },

  async getById(profileId: string): Promise<UserProfile> {
    const dto = await apiRequest<ProfileDto>(`${API_V1}/profiles/${profileId}`, {
      auth: false,
    });
    return toUserProfile(dto);
  },
};
