"""Esquemas Pydantic del catalogo (lecturas publicas en Fase 1)."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class EventRead(BaseModel):
    id: str
    organizer_id: str
    title: str
    description: str
    starts_at: datetime
    ends_at: datetime | None = None
    location: str | None = None
    cover_path: str | None = None
    event_type: str
    status: str
    capacity: int | None = None

    model_config = ConfigDict(from_attributes=True)


class CourseRead(BaseModel):
    id: str
    author_id: str
    title: str
    description: str
    cover_path: str | None = None
    price_minor: int
    currency: str
    status: str

    model_config = ConfigDict(from_attributes=True)
