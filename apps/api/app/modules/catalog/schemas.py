"""Esquemas Pydantic del catalogo (lecturas publicas en Fase 1)."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class EventCreate(BaseModel):
    """Alta de evento. Solo para administradores."""

    title: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=2000)
    #: Fecha y hora de inicio, ya combinadas por el cliente. Opcional: hay
    #: eventos anunciados "por confirmar".
    starts_at: datetime | None = None
    #: Fin del evento; permite mostrar rangos ("25-26 de agosto").
    ends_at: datetime | None = None
    location: str | None = Field(default=None, max_length=200)
    #: Ruta de la portada en Storage (no una URL): igual que avatar_path.
    cover_path: str | None = Field(default=None, max_length=500)
    #: Invitacion al grupo de WhatsApp del evento.
    whatsapp_url: str | None = Field(default=None, max_length=500)
    #: Valores admitidos por el CHECK de la tabla (0001_initial.sql). No usar
    #: otros: la fila se rechaza con `events_event_type_check`.
    event_type: str = Field(default="presential", pattern="^(online|presential|live)$")


class CourseCreate(BaseModel):
    """Alta de curso. Solo para administradores."""

    title: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=2000)
    cover_path: str | None = Field(default=None, max_length=500)
    #: Precio en la unidad mayor (soles, pesos...); el modelo guarda centavos.
    price: int = Field(default=0, ge=0)
    currency: str = Field(default="PEN", pattern="^[A-Z]{3}$")


class EventUpdate(BaseModel):
    """Edicion de evento. Solo administradores; todos los campos opcionales."""

    title: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=2000)
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    location: str | None = Field(default=None, max_length=200)
    cover_path: str | None = Field(default=None, max_length=500)
    whatsapp_url: str | None = Field(default=None, max_length=500)
    event_type: str | None = Field(default=None, pattern="^(online|presential|live)$")


class CourseUpdate(BaseModel):
    """Edicion de curso. Solo administradores."""

    title: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=2000)
    cover_path: str | None = Field(default=None, max_length=500)
    price: int | None = Field(default=None, ge=0)
    currency: str | None = Field(default=None, pattern="^[A-Z]{3}$")


class EventRead(BaseModel):
    id: str
    organizer_id: str
    title: str
    description: str
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    location: str | None = None
    cover_path: str | None = None
    whatsapp_url: str | None = None
    event_type: str
    status: str
    capacity: int | None = None
    registrations_count: int = 0
    reserved_by_me: bool = False

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
