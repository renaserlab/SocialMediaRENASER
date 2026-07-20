"""Esquemas de moderación."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ReportCreate(BaseModel):
    entity_type: str = Field(pattern=r"^(user|post|comment|message|circle)$")
    entity_id: str | None = None
    reported_user_id: str | None = None
    reason: str = Field(min_length=2, max_length=200)
    details: str | None = Field(default=None, max_length=2000)


class ReportRead(BaseModel):
    id: str
    entity_type: str
    entity_id: str | None
    reason: str
    status: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
