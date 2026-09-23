"""Las tablas de reseñas de evento (migración 0067).

EL SELLO NO ES UNA COLUMNA. No hay ningún `verified` que alguien pueda escribir:
una reseña apunta a su `checkin_id`, y esa fila solo existe si esa persona entró.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.modules.events.models import _uuid
from app.shared.database import Base


class EventReview(Base):
    """Una valoración de quien asistió. Una por persona y evento."""

    __tablename__ = "event_reviews"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    event_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("events.id", ondelete="CASCADE")
    )
    author_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE")
    )
    #: LA PRUEBA DE QUE ENTRÓ. Sin esta fila no hay reseña.
    checkin_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("event_checkins.id", ondelete="RESTRICT")
    )
    ticket_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("event_tickets.id", ondelete="RESTRICT")
    )

    #: «¿Entregó lo que anunció?». NO es la media de los ejes.
    overall: Mapped[int] = mapped_column(SmallInteger)
    content: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    organization: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    venue: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    safety: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    value: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)

    #: Nulo = no contestó. No se deduce de la puntuación.
    recommends: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)

    status: Mapped[str] = mapped_column(String(16), server_default=text("'visible'"))
    moderation_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    moderated_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    moderated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("overall between 1 and 5", name="event_reviews_general"),
        CheckConstraint("status in ('visible', 'hidden')", name="event_reviews_estado"),
        CheckConstraint(
            "(status = 'hidden') = (moderated_at is not null)",
            name="event_reviews_escondida_con_fecha",
        ),
        UniqueConstraint("event_id", "author_id", name="event_reviews_una_por_persona"),
        UniqueConstraint("checkin_id", name="event_reviews_un_acceso"),
        Index(
            "event_reviews_del_evento",
            "event_id",
            text("created_at desc"),
            text("id desc"),
            postgresql_where=text("status = 'visible'"),
            sqlite_where=text("status = 'visible'"),
        ),
    )


class EventReviewReply(Base):
    """La respuesta del organizador. Una VISIBLE por reseña."""

    __tablename__ = "event_review_replies"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    review_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("event_reviews.id", ondelete="CASCADE")
    )
    author_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE")
    )
    body: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), server_default=text("'draft'"))
    moderation_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    moderated_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    moderated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "status in ('draft', 'visible', 'hidden')",
            name="event_review_replies_estado",
        ),
        Index(
            "event_review_replies_una_visible",
            "review_id",
            unique=True,
            postgresql_where=text("status = 'visible'"),
            sqlite_where=text("status = 'visible'"),
        ),
    )


class EventReviewModeration(Base):
    """El historial de moderación. SOLO AÑADIR, y lo impone un disparador."""

    __tablename__ = "event_review_moderation"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    review_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("event_reviews.id", ondelete="CASCADE"),
        nullable=True,
    )
    reply_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("event_review_replies.id", ondelete="CASCADE"),
        nullable=True,
    )
    actor_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    from_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    to_status: Mapped[str] = mapped_column(Text)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "(review_id is null) <> (reply_id is null)",
            name="event_review_moderation_de_algo",
        ),
    )
