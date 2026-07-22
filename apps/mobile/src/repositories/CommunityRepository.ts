import { apiRequest, API_V1 } from '@/services/api';
import type { Circle } from '@/types';

/** Circulo tal y como lo devuelve el backend. */
export type CircleDto = {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  cover_path: string | null;
  is_private: boolean;
  members_count: number;
  is_member: boolean;
};

export type CircleDetail = Circle & {
  isMember: boolean;
  isPrivate: boolean;
};

function toCircle(dto: CircleDto): CircleDetail {
  return {
    id: dto.id,
    name: dto.name,
    description: dto.description ?? '',
    members: dto.members_count ?? 0,
    isMember: dto.is_member ?? false,
    isPrivate: dto.is_private ?? true,
  };
}

/** Circulos a traves del backend FastAPI. */
export const CommunityRepository = {
  async list(): Promise<CircleDetail[]> {
    const dtos = await apiRequest<CircleDto[]>(`${API_V1}/circles`);
    return dtos.map(toCircle);
  },

  async getById(circleId: string): Promise<CircleDetail> {
    const dto = await apiRequest<CircleDto>(`${API_V1}/circles/${circleId}`);
    return toCircle(dto);
  },

  async join(circleId: string): Promise<void> {
    await apiRequest(`${API_V1}/circles/${circleId}/join`, { method: 'POST' });
  },

  async leave(circleId: string): Promise<void> {
    await apiRequest(`${API_V1}/circles/${circleId}/leave`, { method: 'DELETE' });
  },
};
