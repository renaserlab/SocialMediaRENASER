import { apiRequest, API_V1 } from '@/services/api';

export type ReportInput = {
  entityType: 'user' | 'post' | 'comment' | 'message' | 'circle';
  entityId?: string;
  reportedUserId?: string;
  reason: string;
  details?: string;
};

export const ReportRepository = {
  async create(input: ReportInput): Promise<void> {
    await apiRequest<unknown>(`${API_V1}/reports`, {
      method: 'POST',
      body: JSON.stringify({
        entity_type: input.entityType,
        entity_id: input.entityId ?? null,
        reported_user_id: input.reportedUserId ?? null,
        reason: input.reason,
        details: input.details ?? null,
      }),
    });
  },
};
