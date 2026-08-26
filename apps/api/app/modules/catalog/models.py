"""Modelos ORM del catalogo: eventos y cursos.

Coinciden con public.events / public.courses de la migracion inicial.
"""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    Uuid,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.shared.database import Base
from app.shared.enums import content_status

#: `text[]` en PostgreSQL, JSON en SQLite (la base de los tests), igual que en
#: `recommendations/models.py`. Sin la variante, los tests no podrian ni crear
#: las tablas.
_LISTA_DE_TEXTO = ARRAY(Text).with_variant(JSON, "sqlite")


def _uuid() -> str:
    return str(uuid4())


class Event(Base):
    __tablename__ = "events"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    organizer_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text, default="", server_default="")
    # Opcional: un evento puede anunciarse antes de cerrar la fecha.
    starts_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), index=True, nullable=True
    )
    ends_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    location: Mapped[str | None] = mapped_column(Text, nullable=True)
    cover_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Invitacion al grupo donde se dan los detalles del evento.
    whatsapp_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    event_type: Mapped[str] = mapped_column(String(20), server_default="online")
    status: Mapped[str] = mapped_column(content_status, server_default="published")
    capacity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class EventRegistration(Base):
    __tablename__ = "event_registrations"

    event_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("events.id", ondelete="CASCADE"),
        primary_key=True,
    )
    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        primary_key=True,
    )
    status: Mapped[str] = mapped_column(String(16), server_default="confirmed")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Course(Base):
    __tablename__ = "courses"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    author_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text, default="", server_default="")
    cover_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    price_minor: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    currency: Mapped[str] = mapped_column(String(3), server_default="PEN")
    status: Mapped[str] = mapped_column(content_status, server_default="draft")
    # Anunciado pero sin contenido todavia (migracion 0014). NO es `draft`: un
    # borrador solo lo ve su autor, esto lo ve todo el mundo como «Proximamente».
    # La columna existe en produccion desde la 0014; se mapea ahora porque el
    # servidor necesita decidir si un curso asi puede recomendarse.
    coming_soon: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    # «Lo que aprenderas», con su orden. La columna existe en produccion desde
    # la 0013 y la app ya la escribe, asi que mapearla es seguro: `select(Course)`
    # la pide y esta ahi.
    #
    # NO SE DUPLICA. La 0034 podria haber anadido un `learning_outcomes` con el
    # mismo significado, y entonces la mitad de los cursos tendria sus puntos en
    # una columna y la mitad en la otra. Los resultados de aprendizaje son ESTO.
    #
    # Sin `server_default`: en PostgreSQL la columna ya lo trae de la 0013, y
    # declararlo aqui haria que SQLite (los tests) escribiera literalmente la
    # cadena '{}', que al releerla sale como diccionario y no como lista.
    highlights: Mapped[list[str]] = mapped_column(_LISTA_DE_TEXTO, default=list)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
