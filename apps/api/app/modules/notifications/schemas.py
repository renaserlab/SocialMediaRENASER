"""Esquemas de notificaciones."""

from datetime import datetime

from pydantic import BaseModel

from app.modules.content.schemas import AuthorSummary


class NotificationRead(BaseModel):
    id: str
    type: str
    actor: AuthorSummary | None = None
    entity_type: str | None = None
    entity_id: str | None = None
    read: bool = False
    created_at: datetime
