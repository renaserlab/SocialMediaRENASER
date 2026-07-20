"""Esquemas de mensajería."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.modules.content.schemas import AuthorSummary


class DirectConversationCreate(BaseModel):
    user_id: str


class ConversationRead(BaseModel):
    id: str
    kind: str
    title: str | None = None
    # Para chats directos: el otro participante.
    other: AuthorSummary | None = None
    last_message: str | None = None
    last_message_at: datetime | None = None
    unread_count: int = 0
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class MessageCreate(BaseModel):
    body: str = Field(min_length=1, max_length=5000)


class MessageRead(BaseModel):
    id: str
    conversation_id: str
    sender: AuthorSummary
    body: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
