"""Modelos ORM del perfil de recomendacion. Mapean la migracion 0026.

El esquema lo poseen las migraciones de Supabase; esto solo lo mapea para
poder consultarlo. Los tipos de lista (`text[]`, `uuid[]`) se declaran con
`ARRAY` de PostgreSQL pero degradan a JSON en SQLite, que es la base que usan
los tests: por eso llevan un `with_variant`.
"""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    JSON,
    Text,
    Uuid,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.shared.database import Base


def _uuid() -> str:
    return str(uuid4())


#: `text[]` en PostgreSQL, JSON en SQLite. Sin la variante, los tests (que
#: corren sobre SQLite en memoria) no podrian ni crear las tablas.
_LISTA_DE_TEXTO = ARRAY(Text).with_variant(JSON, "sqlite")
_LISTA_DE_UUID = ARRAY(Uuid(as_uuid=False)).with_variant(JSON, "sqlite")


class Topic(Base):
    """Un tema de la taxonomia canonica.

    Es configuracion del producto: crece por migracion, no por peticiones de
    usuario. Por eso no hay endpoint que lo escriba.
    """

    __tablename__ = "topics"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    slug: Mapped[str] = mapped_column(Text, unique=True)
    name: Mapped[str] = mapped_column(Text)
    # `group` esta reservada en SQL; ver el comentario de la migracion.
    topic_group: Mapped[str] = mapped_column(Text, default="general", server_default="general")
    active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    position: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class UserTopicRelation(Base):
    """PERSONA --relacion--> TEMA.

    Una sola tabla para los seis verbos. Ver la migracion 0026 para el porque.
    """

    __tablename__ = "user_topic_relations"
    __table_args__ = (
        UniqueConstraint("user_id", "topic_id", "relation", name="user_topic_relations_unica"),
    )

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    topic_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("topics.id", ondelete="CASCADE"), index=True
    )
    relation: Mapped[str] = mapped_column(Text)
    source: Mapped[str] = mapped_column(Text, default="onboarding", server_default="onboarding")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class RecommendationPreference(Base):
    """Lo que la persona respondio y que no es una relacion con un tema."""

    __tablename__ = "recommendation_preferences"

    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), primary_key=True
    )
    onboarding_version: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    skipped: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    goals: Mapped[list[str]] = mapped_column(_LISTA_DE_TEXTO, default=list)
    preferred_connection_types: Mapped[list[str]] = mapped_column(
        _LISTA_DE_TEXTO, default=list
    )
    preferred_content_formats: Mapped[list[str]] = mapped_column(
        _LISTA_DE_TEXTO, default=list
    )
    offer_modes: Mapped[list[str]] = mapped_column(_LISTA_DE_TEXTO, default=list)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class BehaviorEvent(Base):
    """Una senal de uso. Sin texto, sin mensajes, sin atributos sensibles."""

    __tablename__ = "behavior_events"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    event_type: Mapped[str] = mapped_column(Text)
    entity_type: Mapped[str] = mapped_column(Text)
    entity_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    topic_ids: Mapped[list[str] | None] = mapped_column(_LISTA_DE_UUID, nullable=True)
    value: Mapped[float | None] = mapped_column(Float, nullable=True)
    dwell_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source: Mapped[str] = mapped_column(Text, default="client", server_default="client")
    event_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
