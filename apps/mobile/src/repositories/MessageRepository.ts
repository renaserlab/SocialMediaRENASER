import { apiRequest, API_V1 } from '@/services/api';
import {
  ConversationDto,
  MessageDto,
  toConversation,
  toMessage,
} from '@/mappers/messageMapper';
import type { Conversation, Message } from '@/types';

export const MessageRepository = {
  async listConversations(): Promise<Conversation[]> {
    const dtos = await apiRequest<ConversationDto[]>(`${API_V1}/conversations`);
    return dtos.map(toConversation);
  },

  async getOrCreateDirect(userId: string): Promise<Conversation> {
    const dto = await apiRequest<ConversationDto>(`${API_V1}/conversations/direct`, {
      method: 'POST',
      body: JSON.stringify({ user_id: userId }),
    });
    return toConversation(dto);
  },

  async listMessages(
    conversationId: string,
    currentUserId?: string | null,
  ): Promise<Message[]> {
    const dtos = await apiRequest<MessageDto[]>(
      `${API_V1}/conversations/${conversationId}/messages?limit=50`,
    );
    return dtos.map((d) => toMessage(d, currentUserId));
  },

  async sendMessage(
    conversationId: string,
    body: string,
    currentUserId?: string | null,
  ): Promise<Message> {
    const dto = await apiRequest<MessageDto>(
      `${API_V1}/conversations/${conversationId}/messages`,
      { method: 'POST', body: JSON.stringify({ body }) },
    );
    return toMessage(dto, currentUserId);
  },

  async markRead(conversationId: string): Promise<void> {
    await apiRequest<void>(`${API_V1}/conversations/${conversationId}/read`, {
      method: 'POST',
    });
  },
};
