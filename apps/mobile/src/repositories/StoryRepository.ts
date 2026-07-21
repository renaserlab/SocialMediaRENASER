import {
  StoryGroupDto,
  StoryViewerDto,
  toStoryGroup,
  toStoryViewer,
} from '@/mappers/storyMapper';
import { apiRequest, API_V1 } from '@/services/api';
import { signMediaUrls, type UploadedMedia } from '@/services/storage';
import type { StoryGroup, StoryViewer } from '@/types';

/**
 * Historias a traves del backend FastAPI. Igual que en el resto de
 * repositorios, la identidad la resuelve el backend desde el JWT.
 */
export const StoryRepository = {
  /** Historias vigentes agrupadas por autor, ya con las URLs firmadas. */
  async list(): Promise<StoryGroup[]> {
    const dtos = await apiRequest<StoryGroupDto[]>(`${API_V1}/stories`);
    const groups = dtos.map(toStoryGroup);

    // El bucket es privado: una sola firma en lote para todos los tramos.
    const paths = groups.flatMap((group) => group.items.map((item) => item.storagePath));
    if (paths.length > 0) {
      const urls = await signMediaUrls(paths);
      groups.forEach((group) => {
        group.items.forEach((item) => {
          item.mediaUrl = urls[item.storagePath];
        });
      });
    }
    return groups;
  },

  async create(
    media: UploadedMedia,
    { durationMs = 5000, caption = '' }: { durationMs?: number; caption?: string } = {},
  ): Promise<void> {
    await apiRequest<unknown>(`${API_V1}/stories`, {
      method: 'POST',
      body: JSON.stringify({
        storage_path: media.storagePath,
        media_type: media.mediaType,
        duration_ms: durationMs,
        caption,
      }),
    });
  },

  async remove(storyId: string): Promise<void> {
    await apiRequest<void>(`${API_V1}/stories/${storyId}`, { method: 'DELETE' });
  },

  /** Idempotente: el visor lo llama cada vez que muestra un tramo. */
  async markViewed(storyId: string): Promise<void> {
    await apiRequest<void>(`${API_V1}/stories/${storyId}/view`, { method: 'POST' });
  },

  async listViewers(storyId: string): Promise<StoryViewer[]> {
    const dtos = await apiRequest<StoryViewerDto[]>(`${API_V1}/stories/${storyId}/viewers`);
    return dtos.map(toStoryViewer);
  },
};
